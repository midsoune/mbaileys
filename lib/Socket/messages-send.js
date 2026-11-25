"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const crypto_1 = require("crypto")
const path_1 = require("path")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Utils_1 = require("../Utils")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const WAUSync_1 = require("../WAUSync")
const username_1 = require("./username")
const link_preview_1 = require("../Utils/link-preview")
const make_keyed_mutex_1 = require("../Utils/make-mutex")
const message_composer_1 = require("../Utils/message-composer")
const rich_message_utils_1 = require("../Utils/rich-message-utils")

const makeMessagesSocket = (config) => {
    const { logger, maxMsgRetryCount, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: axiosOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache } = config
    const baseSock = username_1.makeUsernameSocket(config)
    const { ev, authState, processingMutex, signalRepository, upsertMessage, createCallLink, query, fetchPrivacySettings, sendNode, groupQuery, groupMetadata, groupToggleEphemeral, newsletterWMexQuery, executeUSyncQuery, resolveUsername, resolveUsernames } = baseSock

    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    })

    // Initialize message retry manager if enabled
    const messageRetryManager = enableRecentMessageCache ? new Utils_1.MessageRetryManager(logger, maxMsgRetryCount) : null

    // Prevent race conditions in Signal session encryption by user
    const encryptionMutex = make_keyed_mutex_1.makeKeyedMutex()

    let mediaConn

    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn

        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {

                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                })

                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn')

                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }

                logger.debug('fetched media conn')

                return node
            })()
        }

        return mediaConn
    }

    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        }

        const isReadReceipt = type === 'read' || type === 'read-self'

        if (isReadReceipt) {
            node.attrs.t = Utils_1.unixTimestampSeconds().toString()
        }

        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        }

        else {
            node.attrs.to = jid
            if (participant) {
                node.attrs.participant = participant
            }
        }

        if (type) {
            node.attrs.type = WABinary_1.isJidNewsletter(jid) ? 'read-self' : type
        }

        const remainingMessageIds = messageIds.slice(1)

        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ]
        }

        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')

        await sendNode(node)
    }

    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = Utils_1.aggregateMessageKeysNotFromMe(keys)

        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }

    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()

        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'

        await sendReceipts(keys, readType)
    }

    /**
     * Deduplicate JIDs when both LID and PN versions exist for same user
     * Prefers LID over PN to maintain single encryption layer
     */
    const deduplicateLidPnJids = (jids) => {
        const lidUsers = new Set()
        const filteredJids = []

        // Collect all LID users
        for (const jid of jids) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user)
                    lidUsers.add(user)
            }
        }

        // Filter out PN versions when LID exists
        for (const jid of jids) {
            if (WABinary_1.isJidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user && lidUsers.has(user)) {
                    logger.debug({ jid }, 'Skipping PN - LID version exists')
                    continue
                }
            }
            filteredJids.push(jid)
        }
        return filteredJids
    }

    /**
     * Normalizes group participant identities into canonical WhatsApp JIDs (LID or PN).
     * Resolves any username-based participants before device resolution and encryption.
     * Updates the participant objects with canonical identities and stores any discovered LID-PN mappings.
     */
    const normalizeGroupParticipants = async (participants, addressingMode) => {
        if (!Array.isArray(participants) || !participants.length) {
            return []
        }

        const isLidMode = addressingMode === 'lid' || addressingMode === Types_1.WAMessageAddressingMode.LID
        const resolvedJids = []
        const usernamesToResolve = []

        for (let i = 0; i < participants.length; i++) {
            const p = participants[i]
            if (!p) continue

            // 1. Check if participant already has a canonical LID or PN identity
            let lid = p.lid && WABinary_1.isLidUser(p.lid) ? p.lid : (p.id && WABinary_1.isLidUser(p.id) ? p.id : undefined)
            let pn = p.phoneNumber && WABinary_1.isPnUser(p.phoneNumber)
                ? p.phoneNumber
                : (p.pn && WABinary_1.isPnUser(p.pn) ? p.pn : (p.id && WABinary_1.isPnUser(p.id) ? p.id : undefined))

            // Check existing LID mapping store before network resolution (PRD Section 17)
            if (lid && !pn && signalRepository?.lidMapping?.getPNForLID) {
                try {
                    const mappedPn = await signalRepository.lidMapping.getPNForLID(lid)
                    if (mappedPn) {
                        const mappedPnForParticipant = WABinary_1.jidDecode(lid)?.device === undefined
                            ? WABinary_1.jidNormalizedUser(mappedPn)
                            : mappedPn
                        pn = mappedPnForParticipant
                        p.phoneNumber = mappedPnForParticipant
                    }
                } catch (_) {}
            } else if (pn && !lid && signalRepository?.lidMapping?.getLIDForPN) {
                try {
                    const mappedLid = await signalRepository.lidMapping.getLIDForPN(pn)
                    if (mappedLid) {
                        const mappedLidForParticipant = WABinary_1.jidDecode(pn)?.device === undefined
                            ? WABinary_1.jidNormalizedUser(mappedLid)
                            : mappedLid
                        lid = mappedLidForParticipant
                        p.lid = mappedLidForParticipant
                    }
                } catch (_) {}
            }

            // If both LID and PN are known, store the mapping in signalRepository
            if (lid && pn && signalRepository?.lidMapping?.storeLIDPNMappings) {
                try {
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])
                } catch (_) {}
            }

            // If we have a canonical identity, use it!
            const canonicalJid = isLidMode ? (lid || pn) : (pn || lid)
            if (canonicalJid) {
                p.id = canonicalJid
                if (lid) p.lid = lid
                if (pn) p.phoneNumber = pn
                resolvedJids.push(canonicalJid)
                continue
            }

            // 2. Identify username target
            let usernameTarget = p.username
            if (!usernameTarget && typeof p.id === 'string') {
                const trimmed = p.id.trim()
                if (trimmed.startsWith('@') && trimmed.length > 1) {
                    usernameTarget = trimmed.slice(1)
                } else if (!trimmed.includes('@') && !/^\d+$/.test(trimmed)) {
                    usernameTarget = trimmed
                }
            }

            if (usernameTarget) {
                const cleanUsername = usernameTarget.replace(/^@/, '').toLowerCase().trim()
                usernamesToResolve.push({ username: cleanUsername, participant: p })
            } else if (p.id && (WABinary_1.isLidUser(p.id) || WABinary_1.isPnUser(p.id))) {
                resolvedJids.push(p.id)
            } else {
                logger.warn({ participant: p }, '[GroupMessage] Participant has no canonical identity or username')
            }
        }

        // 3. Resolve uncached/unresolved usernames in batch
        if (usernamesToResolve.length > 0) {
            logger.debug({ count: usernamesToResolve.length }, '[GroupMessage] Resolving username participants')
            const uniqueUsernames = Array.from(new Set(usernamesToResolve.map(u => u.username)))

            const resolveFn = sock?.resolveUsernames || resolveUsernames || (async (list) => {
                const singleFn = sock?.resolveUsername || resolveUsername
                return Promise.all(list.map(u => singleFn(u)))
            })

            const results = await resolveFn(uniqueUsernames)
            const resultMap = new Map()
            for (let i = 0; i < uniqueUsernames.length; i++) {
                resultMap.set(uniqueUsernames[i], results[i])
            }

            const newMappings = []

            for (const { username, participant } of usernamesToResolve) {
                const resolution = resultMap.get(username)
                if (!resolution || (!resolution.lid && !resolution.pn && !resolution.jid)) {
                    logger.error({ username }, '[GroupMessage] Failed to resolve username participant')
                    throw new Types_1.UsernameNotFoundError(username)
                }

                const chosenLid = resolution.lid || (resolution.jid && WABinary_1.isLidUser(resolution.jid) ? resolution.jid : undefined)
                const chosenPn = resolution.pn || (resolution.jid && WABinary_1.isPnUser(resolution.jid) ? resolution.jid : undefined)

                participant.username = resolution.username || username
                if (chosenLid) participant.lid = chosenLid
                if (chosenPn) participant.phoneNumber = chosenPn

                if (chosenLid && chosenPn) {
                    newMappings.push({ lid: chosenLid, pn: chosenPn })
                }

                const canonical = isLidMode ? (chosenLid || chosenPn || resolution.jid) : (chosenPn || chosenLid || resolution.jid)
                participant.id = canonical
                resolvedJids.push(canonical)

                logger.debug({
                    username,
                    selectedIdentity: canonical,
                    lid: chosenLid,
                    pn: chosenPn
                }, '[GroupMessage] Resolved username participant to canonical identity')
            }

            if (newMappings.length > 0 && signalRepository?.lidMapping?.storeLIDPNMappings) {
                try {
                    await signalRepository.lidMapping.storeLIDPNMappings(newMappings)
                } catch (_) {}
            }
        }

        return Array.from(new Set(resolvedJids.filter(Boolean)))
    }

    /** Fetch image for groups, user, and newsletter **/
    const profilePictureUrl = async (jid) => {
        if (WABinary_1.isJidNewsletter(jid)) {

            let node = await newsletterWMexQuery(undefined, Types_1.QueryIds.METADATA, {
                input: {
                    key: jid,
                    type: 'JID',
                    view_role: 'GUEST'
                },
                fetch_viewer_metadata: true,
                fetch_full_image: true,
                fetch_creation_time: true
            })

            let result = WABinary_1.getBinaryNodeChild(node, 'result')?.content?.toString()

            let metadata = JSON.parse(result).data[Types_1.XWAPaths.NEWSLETTER]

            return Utils_1.getUrlFromDirectPath(metadata.thread_metadata.picture?.direct_path || '')

        }

        else {
            const result = await query({
                tag: 'iq',
                attrs: {
                    target: WABinary_1.jidNormalizedUser(jid),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:profile:picture'
                },
                content: [{
                    tag: 'picture',
                    attrs: {
                        type: 'image',
                        query: 'url'
                    }
                }]
            })

            const child = WABinary_1.getBinaryNodeChild(result, 'picture')

            return child?.attrs?.url || null
        }
    }

    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []

        if (!useCache) {
            logger.debug('not using cache for devices')
        }

        const toFetch = []

        jids = deduplicateLidPnJids(Array.from(new Set(jids.filter(Boolean))))
        const jidsWithUser = jids
            .map(jid => {
                if (!jid) return null
                const decoded = WABinary_1.jidDecode(jid)
                const user = decoded?.user
                if (!user) return null
                const device = decoded?.device
                const isExplicitDevice = typeof device === 'number' && device >= 0

                if (isExplicitDevice && user) {
                    deviceResults.push({
                        user,
                        device,
                        wireJid: jid // again this makes no sense
                    });
                    return null
                }

                jid = WABinary_1.jidNormalizedUser(jid)
                return { jid, user }
            })
            .filter(jid => jid !== null)

        let mgetDevices

        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean)
            mgetDevices = await userDevicesCache.mget(usersToFetch)
        }

        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] ||
                    (userDevicesCache.mget ? undefined : (await userDevicesCache.get(user)))

                if (devices) {
                    const isLidJid = WABinary_1.isLidUser(jid)
                    const devicesWithWire = devices.map(d => ({
                        ...d,
                        wireJid: isLidJid ? WABinary_1.jidEncode(d.user, 'lid', d.device) : WABinary_1.jidEncode(d.user, 's.whatsapp.net', d.device)
                    }))

                    deviceResults.push(...devicesWithWire)
                    logger.trace({ user }, 'using cache for devices')
                }
                else {
                    toFetch.push(jid)
                }
            }
            else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) {
            return deviceResults
        }

        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user)
                    requestedLidUsers.add(user)
            }
        }

        const query = new WAUSync_1.USyncQuery().withContext('message').withDeviceProtocol()
        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }

        const result = await executeUSyncQuery(query)

        if (result) {
            const extracted = Utils_1.extractDeviceJids(result?.list, authState.creds.me.id, ignoreZeroDevices)
            const deviceMap = {}

            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user]?.push(item)
            }

            // Process each user's devices as a group for bulk LID migration
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user)

                // Process all devices for this user
                for (const item of userDevices) {
                    const finalWireJid = isLidUser
                        ? WABinary_1.jidEncode(user, 'lid', item.device)
                        : WABinary_1.jidEncode(item.user, 's.whatsapp.net', item.device)
                    deviceResults.push({
                        ...item,
                        wireJid: finalWireJid
                    });

                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalWireJid,
                        usedLid: isLidUser
                    }, 'Processed device with LID priority')
                }
            }

            if (userDevicesCache.mset) {
                // if the cache supports mset, we can set all devices in one go
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
            }

            else {
                for (const key in deviceMap) {
                    if (deviceMap[key])
                        await userDevicesCache.set(key, deviceMap[key])
                }
            }

        }
        return deviceResults
    }

    const updateMemberLabel = (jid, memberLabel) => {
        if (!WABinary_1.isJidGroup(jid)) {
            throw new Error('Jid must a group!')
        }

        const protocolMessage = {
            protocolMessage: {
                type: WAProto_1.proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: {
                    label: memberLabel?.slice(0, 30),
                    labelTimestamp: Utils_1.unixTimestampSeconds()
                }
            }
        }

        return relayMessage(jid, protocolMessage, {
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        tag_reason: 'user_update',
                        appdata: 'member_tag'
                    }
                }
            ]
        })
    }

    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false
        const jidsRequiringFetch = []

        // Apply same deduplication as in getUSyncDevices
        jids = deduplicateLidPnJids(jids)

        if (force) {
            // Check which sessions are missing (with LID migration check)
            const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid))
            const sessions = await authState.keys.get('session', addrs)

            const checkJidSession = (jid) => {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid)
                const hasSession = !!sessions[signalId]

                // Add to fetch list if no session exists
                // Session type selection (LID vs PN) is handled in encryptMessage
                if (!hasSession) {
                    if (jid.includes('@lid')) {
                        logger.debug({ jid }, 'No LID session found, will create new LID session')
                    }
                    jidsRequiringFetch.push(jid)
                }
            }

            // Process all JIDs
            for (const jid of jids) {
                checkJidSession(jid)
            }
        }
        else {
            const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid))
            const sessions = await authState.keys.get('session', addrs)

            // Group JIDs by user for bulk migration
            const userGroups = new Map()
            for (const jid of jids) {
                const user = WABinary_1.jidNormalizedUser(jid)
                if (!userGroups.has(user)) {
                    userGroups.set(user, [])
                }
                userGroups.get(user).push(jid)
            }

            // Helper to check LID mapping for a user
            const checkUserLidMapping = async (user, userJids) => {
                if (!userJids.some(jid => WABinary_1.isJidUser(jid))) {
                    return { shouldMigrate: false, lidForPN: undefined }
                }

                try {
                    // Convert user to proper PN JID format for getLIDForPN
                    const pnJid = `${user}@s.whatsapp.net`
                    const mapping = await signalRepository.lidMapping.getLIDForPN(pnJid)

                    if (mapping?.includes('@lid')) {
                        logger.debug({ user, lidForPN: mapping, deviceCount: userJids.length }, 'User has LID mapping - preparing bulk migration')
                        return { shouldMigrate: true, lidForPN: mapping }
                    }
                }
                catch (error) {
                    logger.debug({ user, error }, 'Failed to check LID mapping for user')
                }

                return { shouldMigrate: false, lidForPN: undefined }
            }

            // Process each user group for potential bulk LID migration
            for (const [user, userJids] of userGroups) {
                const mappingResult = await checkUserLidMapping(user, userJids)
                const shouldMigrateUser = mappingResult.shouldMigrate
                const lidForPN = mappingResult.lidForPN

                // Migrate all devices for this user if LID mapping exists
                if (shouldMigrateUser && lidForPN) {
                    // Bulk migrate all user devices in single transaction
                    const migrationResult = await signalRepository.migrateSession(userJids, lidForPN)

                    if (migrationResult.migrated > 0) {
                        logger.info({
                            user,
                            lidMapping: lidForPN,
                            migrated: migrationResult.migrated,
                            skipped: migrationResult.skipped,
                            total: migrationResult.total
                        }, 'Completed bulk migration for user devices');
                    }
                    else {
                        logger.debug({
                            user,
                            lidMapping: lidForPN,
                            skipped: migrationResult.skipped,
                            total: migrationResult.total
                        }, 'All user device sessions already migrated');
                    }
                }

                // Direct bulk session check with LID single source of truth
                const addMissingSessionsToFetchList = (jid) => {
                    const signalId = signalRepository.jidToSignalProtocolAddress(jid)

                    if (sessions[signalId]) return

                    // Determine correct JID to fetch (LID if mapping exists, otherwise original)
                    if (jid.includes('@s.whatsapp.net') && shouldMigrateUser && lidForPN) {
                        const decoded = WABinary_1.jidDecode(jid)
                        const lidDeviceJid = decoded.device !== undefined ? `${WABinary_1.jidDecode(lidForPN).user}:${decoded.device}@lid` : lidForPN

                        jidsRequiringFetch.push(lidDeviceJid)
                        logger.debug({ pnJid: jid, lidJid: lidDeviceJid }, 'Adding LID JID to fetch list (conversion)')
                    }

                    else {
                        jidsRequiringFetch.push(jid)
                        logger.debug({ jid }, 'Adding JID to fetch list')
                    }
                }

                userJids.forEach(addMissingSessionsToFetchList)
            }
        }

        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions')

            // DEBUG: Check if there are PN versions of LID users being fetched
            const lidUsersBeingFetched = new Set()
            const pnUsersBeingFetched = new Set()

            for (const jid of jidsRequiringFetch) {
                const user = WABinary_1.jidDecode(jid)?.user

                if (user) {
                    if (WABinary_1.isLidUser(jid)) {
                        lidUsersBeingFetched.add(user)
                    }
                    else if (WABinary_1.isJidUser(jid)) {
                        pnUsersBeingFetched.add(user)
                    }
                }
            }

            // Find overlaps
            const overlapping = Array.from(pnUsersBeingFetched).filter(user => lidUsersBeingFetched.has(user))
            if (overlapping.length > 0) {
                logger.warn({
                    overlapping,
                    lidUsersBeingFetched: Array.from(lidUsersBeingFetched),
                    pnUsersBeingFetched: Array.from(pnUsersBeingFetched)
                }, 'Fetching both LID and PN sessions for same users')
            }

            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid }
                        }))
                    }
                ]
            })

            await Utils_1.parseAndInjectE2ESessions(result, signalRepository)
            didFetchNewSession = true
        }
        return didFetchNewSession
    }

    /** Send Peer Operation */
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        //TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }

        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        }

        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)

        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                // eslint-disable-next-line camelcase
                push_priority: 'high_force',
                // eslint-disable-next-line camelcase
                privacy_sensitive: '1',
            },
             additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        appdata: 'default'
                    }
                }
            ]
        })

        return msgId
    }

    const createParticipantNodes = async (jids, message, extraAttrs, dsmMessage) => {
        let patched = await patchMessageBeforeSending(message, jids)

        if (!Array.isArray(patched)) {
            patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched]
        }

        let shouldIncludeDeviceIdentity = false

        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const meLidUser = meLid ? WABinary_1.jidDecode(meLid)?.user : null
        const devicesByUser = new Map()

        for (const patchedMessageWithJid of patched) {
            const { recipientJid: wireJid, ...patchedMessage } = patchedMessageWithJid
            if (!wireJid)
                continue

            // Extract user from JID for grouping
            const decoded = WABinary_1.jidDecode(wireJid)
            const user = decoded?.user

            if (!user)
                continue

            if (!devicesByUser.has(user)) {
                devicesByUser.set(user, []);
            }

            devicesByUser.get(user).push({ recipientJid: wireJid, patchedMessage })
        }

        // Process each user's devices sequentially, but different users in parallel
        const userEncryptionPromises = Array.from(devicesByUser.entries()).map(([user, userDevices]) => encryptionMutex.mutex(user, async () => {
            logger.debug({ user, deviceCount: userDevices.length }, 'Acquiring encryption lock for user devices');
            const userNodes = []

            // Helper to get encryption JID with LID migration
            const getEncryptionJid = async (wireJid) => {
                if (!WABinary_1.isJidUser(wireJid))
                    return wireJid

                try {
                    const lidForPN = await signalRepository.lidMapping.getLIDForPN(wireJid)

                    if (!lidForPN?.includes('@lid'))
                        return wireJid

                    // Preserve device ID from original wire JID
                    const wireDecoded = WABinary_1.jidDecode(wireJid)
                    const deviceId = wireDecoded?.device || 0
                    const lidDecoded = WABinary_1.jidDecode(lidForPN)
                    const lidWithDevice = WABinary_1.jidEncode(lidDecoded?.user, 'lid', deviceId)

                    // Migrate session to LID for unified encryption layer
                    try {
                        const migrationResult = await signalRepository.migrateSession([wireJid], lidWithDevice)
                        const recipientUser = WABinary_1.jidNormalizedUser(wireJid)
                        const ownPnUser = WABinary_1.jidNormalizedUser(meId)
                        const isOwnDevice = recipientUser === ownPnUser
                        logger.info({ wireJid, lidWithDevice, isOwnDevice }, 'Migrated to LID encryption')

                        // Delete PN session after successful migration
                        try {
                            if (migrationResult.migrated) {
                                await signalRepository.deleteSession([wireJid])
                                logger.debug({ deletedPNSession: wireJid }, 'Deleted PN session')
                            }
                        }
                        catch (deleteError) {
                            logger.warn({ wireJid, error: deleteError }, 'Failed to delete PN session')
                        }
                        return lidWithDevice
                    }
                    catch (migrationError) {
                        logger.warn({ wireJid, error: migrationError }, 'Failed to migrate session')
                        return wireJid
                    }
                }
                catch (error) {
                    logger.debug({ wireJid, error }, 'Failed to check LID mapping')
                    return wireJid
                }
            }

            // Encrypt to this user's devices sequentially to prevent session corruption
            for (const { recipientJid: wireJid, patchedMessage } of userDevices) {
                // DSM logic: Use DSM for own other devices (following whatsmeow implementation)
                let messageToEncrypt = patchedMessage

                if (dsmMessage) {
                    const { user: targetUser } = WABinary_1.jidDecode(wireJid)
                    const { user: ownPnUser } = WABinary_1.jidDecode(meId)
                    const ownLidUser = meLidUser

                    // Check if this is our device (same user, different device)
                    const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)

                    // Exclude exact sender device (whatsmeow: if jid == ownJID || jid == ownLID { continue })
                    const isExactSenderDevice = wireJid === meId || (authState.creds.me?.lid && wireJid === authState.creds.me.lid)

                    if (isOwnUser && !isExactSenderDevice) {
                        messageToEncrypt = dsmMessage
                        logger.debug({ wireJid, targetUser }, 'Using DSM for own device')
                    }
                }

                const bytes = Utils_1.encodeWAMessage(messageToEncrypt)

                // Get encryption JID with LID migration
                const encryptionJid = await getEncryptionJid(wireJid)

                // ENCRYPT: Use the determined encryption identity (prefers migrated LID)
                const { type, ciphertext } = await signalRepository.encryptMessage({
                    jid: encryptionJid, // Unified encryption layer (LID when available)
                    data: bytes
                })

                if (type === 'pkmsg') {
                    shouldIncludeDeviceIdentity = true
                }

                const node = {
                    tag: 'to',
                    attrs: { jid: wireJid }, // Always use original wire identity in envelope
                    content: [
                        {
                            tag: 'enc',
                            attrs: {
                                v: '2',
                                type,
                                ...(extraAttrs || {})
                            },
                            content: ciphertext
                        }
                    ]
                }
                userNodes.push(node)
            }
            logger.debug({ user, nodesCreated: userNodes.length }, 'Releasing encryption lock for user devices');
            return userNodes
        }))

        // Wait for all users to complete (users are processed in parallel)
        const userNodesArrays = await Promise.all(userEncryptionPromises)
        const nodes = userNodesArrays.flat()
        return { nodes, shouldIncludeDeviceIdentity }
    }

    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, useUserDevicesCache, useCachedGroupMetadata, statusJidList, additionalNodes, AI = false, addBizAttributes, syncToOwnDevices = true }) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid

        let didPushAdditional = false
        let shouldIncludeDeviceIdentity = false

        const { user, server } = WABinary_1.jidDecode(jid)

        const statusJid = 'status@broadcast'
        const isGroup = server === 'g.us'
        const isPrivate = server === 's.whatsapp.net'
        const isNewsletter = server == 'newsletter'
        const isStatus = jid === statusJid
        const isLid = server === 'lid'
        if (syncToOwnDevices === false && !isPrivate && !isLid) {
            throw new boom_1.Boom('syncToOwnDevices:false is only supported for direct private chats', { statusCode: 400 })
        }

        // Keep user's original JID choice for envelope addressing
        const finalJid = jid

        // ADDRESSING CONSISTENCY: Match own identity to conversation context
        let ownId = meId

        if (isLid && meLid) {
            ownId = meLid
            logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
        }
        else {
            logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
        }

        msgId = msgId || Utils_1.generateMessageID(authState.creds.me.id)
        useUserDevicesCache = useUserDevicesCache !== false
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

        const participants = []
        const destinationJid = !isStatus ? finalJid : statusJid
        const binaryNodeContent = []
        const devices = []

        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo || {}
        }

        const extraAttrs = {}

        const regexGroupOld = /^(\d{1,15})-(\d+)@g\.us$/

        const messages = Utils_1.normalizeMessageContent(message)

        const pollMessage = messages.pollCreationMessage ||
            messages.pollCreationMessageV2 ||
            messages.pollCreationMessageV3 ||
            messages.pollCreationMessageV4 ||
            messages.pollCreationMessageV5 ||
            messages.pollCreationMessageV6


        if (participant) {
            let partJid = participant.jid
            if (partJid && (partJid.startsWith('@') || (!partJid.includes('@') && !/^\d+$/.test(partJid)))) {
                const resolution = await (sock?.resolveUsername || resolveUsername)(partJid)
                if (resolution && (resolution.lid || resolution.pn || resolution.jid)) {
                    partJid = resolution.lid || resolution.pn || resolution.jid
                    participant = { ...participant, jid: partJid }
                } else {
                    throw new Types_1.UsernameNotFoundError(partJid)
                }
            }

            // when the retry request is not for a group
            // only send to the specific device that asked for a retry
            // otherwise the message is sent out to every device that should be a recipient
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' }
            }

            const { user, device } = WABinary_1.jidDecode(participant.jid)

            devices.push({
                user,
                device,
                wireJid: participant.jid // Use the participant JID as wire JID
            })
        }

        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(messages)

            if (mediaType) {
                extraAttrs['mediatype'] = mediaType
            }

            if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            }

            if (messages.interactiveResponseMessage?.nativeFlowResponseMessage) {
                extraAttrs['native_flow_name'] = messages.interactiveResponseMessage.nativeFlowResponseMessage?.name || 'menu_options'
            }

            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined

                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
                        }

                        else if (!isStatus) {
                            groupData = await groupMetadata(jid)
                        }

                        return groupData
                    })(),

                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid])
                            return result[jid] || {}
                        }

                        return {}

                    })()
                ])

                if (!participant) {
                    const groupAddressingMode = groupData?.addressingMode || (isLid ? Types_1.WAMessageAddressingMode.LID : Types_1.WAMessageAddressingMode.PN)
                    let participantsList = []

                    if (groupData && !isStatus) {
                        participantsList = await normalizeGroupParticipants(groupData.participants, groupAddressingMode)
                    }

                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList)
                    }

                    if (!isStatus) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: groupAddressingMode
                        }
                    }

                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                    devices.push(...additionalDevices)
                }

                const patched = await patchMessageBeforeSending(message, devices.map(d => WABinary_1.jidEncode(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)))
                const bytes = Utils_1.encodeWAMessage(patched)

                // This should match the group's addressing mode and conversation context
                const groupAddressingMode = groupData?.addressingMode || (isLid ? 'lid' : 'pn')
                const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity
                })

                const senderKeyJids = []

                // ensure a connection is established with every device
                for (const device of devices) {
                    // This preserves the LID migration results from getUSyncDevices
                    const deviceJid = device.wireJid
                    const hasKey = !!senderKeyMap[deviceJid]
                    if (!hasKey || !!participant) {
                        senderKeyJids.push(deviceJid)
                        // store that this person has had the sender keys sent to them
                        senderKeyMap[deviceJid] = true
                    }
                }

                // if there are some participants with whom the session has not been established
                // if there are, we re-send the senderkey
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key')
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    }

                    await assertSessions(senderKeyJids, false)

                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)

                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

                    participants.push(...result.nodes)
                }

                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg', ...extraAttrs },
                    content: ciphertext
                })

                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
            }

            else if (isNewsletter) {
                // Message edit
                if (message.protocolMessage?.editedMessage) {
                    msgId = message.protocolMessage.key?.id
                    message = message.protocolMessage.editedMessage
                }

                // Message delete
                if (message.protocolMessage?.type === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = message.protocolMessage.key?.id
                    message = {}
                }

                const patched = await patchMessageBeforeSending(message, [])
                const bytes = Utils_1.encodeNewsletterMessage(patched)

                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: extraAttrs,
                    content: bytes
                })
            }

            else {
                const { user: ownUser } = WABinary_1.jidDecode(ownId)

                if (!participant) {
                    const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
                    devices.push({
                        user,
                        device: 0,
                        wireJid: WABinary_1.jidEncode(user, targetUserServer, 0)
                    })

                    // Own user matches conversation addressing mode
                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        const ownUserForAddressing = isLid && meLid ? WABinary_1.jidDecode(meLid).user : WABinary_1.jidDecode(meId).user
                        devices.push({
                            user: ownUserForAddressing,
                            device: 0,
                            wireJid: WABinary_1.jidEncode(ownUserForAddressing, ownUserServer, 0)
                        })
                    }

                    if (additionalAttributes?.['category'] !== 'peer') {
                        // Clear placeholders and enumerate actual devices
                        devices.length = 0

                        // Use conversation-appropriate sender identity
                        const senderIdentity = isLid && meLid
                            ? WABinary_1.jidEncode(WABinary_1.jidDecode(meLid)?.user, 'lid', undefined)
                            : WABinary_1.jidEncode(WABinary_1.jidDecode(meId)?.user, 's.whatsapp.net', undefined)

                        // Enumerate devices for sender and target with consistent addressing
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], false, false)
                        devices.push(...sessionDevices)
                        logger.debug({
                            deviceCount: devices.length,
                            devices: devices.map(d => `${d.user}:${d.device}@${WABinary_1.jidDecode(d.wireJid)?.server}`)
                        }, 'Device enumeration complete with unified addressing')
                    }
                }

                const allJids = []
                const meJids = []
                const otherJids = []

                const { user: mePnUser } = WABinary_1.jidDecode(meId)
                const { user: meLidUser } = meLid ? WABinary_1.jidDecode(meLid) : { user: null }

                for (const { user, wireJid } of devices) {
                    const isExactSenderDevice = wireJid === meId || (meLid && wireJid === meLid)
                    if (isExactSenderDevice) {
                        logger.debug({ wireJid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
                        continue
                    }

                    // Check if this is our device (could match either PN or LID user)
                    const isMe = user === mePnUser || (meLidUser && user === meLidUser)
                    const jid = wireJid

                    if (isMe) {
                        if (syncToOwnDevices !== false) {
                            meJids.push(jid)
                        } else {
                            logger.debug({ jid }, 'skipping self-device message sync')
                        }
                    }

                    else {
                        otherJids.push(jid)
                    }

                    allJids.push(jid)
                }

                await assertSessions([...otherJids, ...meJids], false)

                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    // For own devices: use DSM if available (1:1 chats only)
                    createParticipantNodes(meJids, meMsg || message, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs, meMsg)
                ])

                participants.push(...meNodes)

                participants.push(...otherNodes)

                if (meJids.length > 0 || otherJids.length > 0) {
                    extraAttrs['phash'] = Utils_1.generateParticipantHashV2([...meJids, ...otherJids])
                }

                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
            }

            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                  if (additionalNodes && additionalNodes.length > 0) {
                        binaryNodeContent.push(...additionalNodes)
                        didPushAdditional = true
                    }
                    const peerNode = participants[0]?.content?.[0]

                    if (peerNode) {
                        binaryNodeContent.push(peerNode) // push only enc
                    }
                }

                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    })
                }
            }

            const stanza = {
                tag: 'message',
                attrs: {
                    to: destinationJid,
                    id: msgId,
                    type: getTypeMessage(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            }

            // if the participant to send to is explicitly specified (generally retry recp)
            // ensure the message is only sent to that person
            // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
            if (participant) {
                if (WABinary_1.isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid
                    stanza.attrs.participant = participant.jid
                }

                else if (WABinary_1.areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid
                    stanza.attrs.recipient = destinationJid
                }

                else {
                    stanza.attrs.to = participant.jid
                }
            }

            else {
                stanza.attrs.to = destinationJid
            }

            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: Utils_1.encodeSignedDeviceIdentity(authState.creds.account, true)
                })

                logger.debug({ jid }, 'adding device identity')
            }

            // patch attach <tctoken> for private 1:1 messages (PN or LID) to bypass 463 / reach-out timelock
            if ((isPrivate || isLid) && !participant && additionalAttributes?.['category'] !== 'peer') {
                try {
                    const keysArr = [destinationJid]
                    // if destinationJid is @s.whatsapp.net, also try the @lid equivalent
                    if (!isLid) {
                        try {
                            const lidForPn = await signalRepository.lidMapping.getLIDForPN(destinationJid)
                            // getLIDForPN returns "125207020859643:0@lid" but token stored as "125207020859643@lid"
                            // Strip device suffix ":X" to get bare LID key
                            const bareLid = lidForPn ? lidForPn.replace(/:(\d+)@lid$/, '@lid') : null
                            if (bareLid) keysArr.push(bareLid)
                        } catch (_) { }
                    }
                    const tctokenMap = await authState.keys.get('tctoken', keysArr)
                    let tcEntry = null
                    let tcKey = null
                    for (const k of keysArr) {
                        if (tctokenMap?.[k]?.token) { tcEntry = tctokenMap[k]; tcKey = k; break }
                    }
                    if (tcEntry?.token) {
                        const tokenBuf = Buffer.isBuffer(tcEntry.token) ? tcEntry.token : Buffer.from(tcEntry.token)
                        if (tokenBuf.length) {
                            stanza.content.push({ tag: 'tctoken', attrs: {}, content: tokenBuf })
                            logger.info({ jid: destinationJid, tcKey }, '[wsapme] attached tctoken to outgoing message')
                        }
                    }
                } catch (err) {
                    logger.warn({ err: err?.message, jid: destinationJid }, '[wsapme] failed to attach tctoken')
                }
            }

            if (isGroup && regexGroupOld.test(jid) && !message.reactionMessage) {
                stanza.content.push({
                    tag: 'multicast',
                    attrs: {}
                })
            }

            const hasPollCreationMeta = additionalNodes?.some(node =>
                node.tag === 'meta' && node.attrs?.polltype === 'creation'
            )
            if ((pollMessage && !hasPollCreationMeta) || messages.pollUpdateMessage || messages.eventMessage) {
                stanza.content.push({
                    tag: 'meta',
                    attrs: messages.eventMessage ? { event_type: 'creation'
                    } : messages.pollUpdateMessage ? {
                        polltype: 'vote'
                    } : isNewsletter ? {
                        polltype: 'creation',
                        contenttype: pollMessage?.pollContentType === 2 ? 'image' : 'text'
                    } : {
                        polltype: 'creation',
                        ...(pollMessage?.pollContentType === 2 ? { contenttype: 'image' } : {})
                    }
                })
            }

            if (AI && (isPrivate || isLid)) {
                const botNode = {
                    tag: 'bot',
                    attrs: {
                        biz_bot: '1'
                    }
                }

                const filteredBizBot = WABinary_1.getBinaryFilteredBizBot(additionalNodes ? additionalNodes : [])

                if (filteredBizBot) {
                    stanza.content.push(...additionalNodes)
                    didPushAdditional = true
                }

                else {
                    stanza.content.push(botNode)
                }
            }

            let alreadyHasBizNode = false
            if (!didPushAdditional && additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes)
                alreadyHasBizNode = !addBizAttributes && additionalNodes.some(node => node.tag === 'biz')
            }

            if ((!alreadyHasBizNode && Utils_1.shouldIncludeBizBinaryNode(messages)) || addBizAttributes) {
                const bizNode = WABinary_1.getBizBinaryNode(messages)
                stanza.content.push(bizNode)
            }

            logger.debug({ msgId }, `sending message to ${participants.length} devices`)

            await sendNode(stanza)

            // Add message to retry cache if enabled
            if (messageRetryManager && !participant) {
                messageRetryManager.addRecentMessage(destinationJid, msgId, message)
            }
        }, meId)

        return msgId
    }

    const getTypeMessage = (msg) => {
        const message = Utils_1.normalizeMessageContent(msg)
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3 || message.pollCreationMessageV4 || message.pollCreationMessageV5 || message.pollCreationMessageV6 || message.pollUpdateMessage) {
            return 'poll'
        }
        else if (message.reactionMessage) {
            return 'reaction'
        }
        else if (message.eventMessage) {
            return 'event'
        }
        else if (getMediaType(message)) {
            return 'media'
        }
        else {
            return 'text'
        }
    }

    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        }
        else if (message.stickerMessage) {
            return message.stickerMessage.isLottie ? '1p_sticker' : message.stickerMessage.isAvatar ? 'avatar_sticker' : 'sticker'
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        }
        else if (message.ptvMessage) {
            return 'ptv'
        }
        else if (message.albumMessage) {
            return 'collection'
        }
        else if (message.contactMessage) {
            return 'vcard'
        }
        else if (message.documentMessage) {
            return 'document'
        }
        else if (message.stickerPackMessage) {
            return 'sticker_pack'
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array'
        }
        else if (message.locationMessage) {
            return 'location'
        }
        else if (message.liveLocationMessage) {
            return 'livelocation'
        }
        else if (message.listMessage) {
            return 'list'
        }
        else if (message.listResponseMessage) {
            return 'list_response'
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        }
        else if (message.orderMessage) {
            return 'order'
        }
        else if (message.productMessage) {
            return 'product'
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        }
        else if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'cataloglink'
        }
        else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'productlink'
        }
        else if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) {
            return 'url'
        }
    }



    const getPrivacyTokens = async (jids) => {
        const t = Utils_1.unixTimestampSeconds().toString()

        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: WABinary_1.jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        })

        return result
    }

    const getEphemeralGroup = (jid) => {
        if (!WABinary_1.isJidGroup(jid)) throw new TypeError("Jid should originate from a group!")

        return groupQuery(jid, 'get', [{
            tag: 'query',
            attrs: {
                request: 'interactive'
            }
        }])
            .then((groups) => WABinary_1.getBinaryNodeChild(groups, 'group'))
            .then((metadata) => WABinary_1.getBinaryNodeChild(metadata, 'ephemeral')?.attrs?.expiration || 0)
    }

    const waUploadToServer = Utils_1.getWAUploadToServer(config, refreshMediaConn)

    const waitForMsgMediaUpdate = Utils_1.bindWaitForEvent(ev, 'messages.media-update')

    const sendMetaStep = async (jid, first = {}, options = {}) => {
        if (!first || typeof first !== 'object' || Array.isArray(first)) {
            throw new boom_1.Boom('sendMetaStep first argument must be an object', { statusCode: 400 })
        }
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new boom_1.Boom('sendMetaStep options must be an object', { statusCode: 400 })
        }

        const Status = WAProto_1.proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.PlanningStepStatus
        const steps = []
        let description = String(first.description ?? first.title ?? '')
        let text = first.text
        const responseId = crypto_1.randomUUID()
        const estimatedCompletionTime = options.estimatedCompletionTime
        const toStep = (input = {}) => {
            const requestedStatus = typeof input.status === 'string'
                ? Status[input.status.toUpperCase()]
                : input.status
            const status = requestedStatus !== undefined
                ? requestedStatus
                : input.disabled
                    ? Status.FINISHED
                    : Status.EXECUTING

            return {
                statusTitle: String(input.title ?? ''),
                statusBody: String(input.body ?? ''),
                status: status ?? Status.EXECUTING,
                ...(input.reasoning !== undefined ? { isReasoning: Boolean(input.reasoning) } : {}),
                ...(Array.isArray(input.sections) ? {
                    sections: input.sections.map(section => ({
                        sectionTitle: String(section?.title ?? ''),
                        sectionBody: String(section?.body ?? '')
                    }))
                } : {}),
                ...(Array.isArray(input.sources) ? {
                    sourcesMetadata: input.sources.map(source => ({
                        sourceTitle: String(source?.title ?? ''),
                        sourceUrl: String(source?.url ?? '')
                    }))
                } : {})
            }
        }
        const forwardContextInfo = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
            forwardOrigin: WAProto_1.proto.ContextInfo.ForwardOrigin.META_AI
        }
        const build = () => {
            const responseText = String(text ?? steps[steps.length - 1]?.statusTitle ?? description)
            const unifiedResponse = {
                response_id: responseId,
                sections: [{
                    view_model: {
                        primitive: {
                            text: responseText,
                            __typename: 'GenAIMarkdownTextUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                }]
            }

            return {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2,
                    botMetadata: {
                        botResponseId: responseId,
                        progressIndicatorMetadata: {
                            progressDescription: description,
                            stepsMetadata: steps.map(step => ({ ...step })),
                            ...(estimatedCompletionTime !== undefined
                                ? { estimatedCompletionTime }
                                : {})
                        }
                    }
                },
                botForwardedMessage: {
                    message: {
                        richResponseMessage: {
                            messageType: WAProto_1.proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
                            submessages: [{ messageType: WAProto_1.proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: responseText }],
                            unifiedResponse: {
                                data: Buffer.from(JSON.stringify(unifiedResponse))
                            },
                            contextInfo: forwardContextInfo
                        }
                    }
                }
            }
        }

        steps.push(toStep(first))
        const sentMessage = await sock.sendMessage(jid, {
            raw: true,
            ...build()
        }, { ...options, quoted: options.quoted })

        const handle = {
            key: sentMessage.key,
            message: sentMessage,
            steps,
            update: async () => {
                const message = {
                    botForwardedMessage: {
                        message: {
                            protocolMessage: {
                                key: sentMessage.key,
                                type: WAProto_1.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
                                editedMessage: build(),
                                timestampMs: Date.now()
                            }
                        }
                    }
                }
                const editId = Utils_1.generateMessageID(authState.creds.me?.id)
                await relayMessage(sentMessage.key.remoteJid || jid, message, {
                    messageId: editId,
                    additionalAttributes: { edit: '1' },
                    participant: options.deviceJid ? { jid: options.deviceJid } : undefined,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    statusJidList: options.statusJidList,
                    additionalNodes: options.additionalNodes,
                    AI: options.ai,
                    syncToOwnDevices: options.syncToOwnDevices
                })
                return { key: sentMessage.key, editId, message }
            },
            step: async (next = {}, stepOptions = {}) => {
                if (!next || typeof next !== 'object' || Array.isArray(next)) {
                    throw new boom_1.Boom('sendMetaStep.step argument must be an object', { statusCode: 400 })
                }
                if (!stepOptions || typeof stepOptions !== 'object' || Array.isArray(stepOptions)) {
                    throw new boom_1.Boom('sendMetaStep.step options must be an object', { statusCode: 400 })
                }
                if (stepOptions.keepPrevious !== true) {
                    for (const step of steps) {
                        if (step.status === Status.EXECUTING || step.status === Status.PLANNED) {
                            step.status = Status.FINISHED
                        }
                    }
                }
                steps.push(toStep(next))
                text = next.text
                if (next.description !== undefined) description = String(next.description)
                return handle.update()
            },
            done: async (last) => {
                for (const step of steps) {
                    step.status = Status.FINISHED
                }
                if (typeof last === 'string') {
                    description = last
                } else if (last && typeof last === 'object') {
                    if (last.title !== undefined || last.body !== undefined) {
                        steps.push(toStep({ ...last, status: Status.FINISHED, disabled: true }))
                    }
                    if (last.description) description = String(last.description)
                    text = last.text
                }
                return handle.update()
            }
        }

        handle.finish = handle.done
        return handle
    }

    const sendMotionPhoto = async (jid, content, options = {}) => {
        if (!content || typeof content !== 'object' || content.image == null || content.video == null) {
            throw new boom_1.Boom('motionPhoto requires both image and video media', { statusCode: 400 })
        }

        const presentationOffsetMs = content.presentationOffsetMs ?? 0
        if (!Number.isSafeInteger(presentationOffsetMs) || presentationOffsetMs < 0) {
            throw new boom_1.Boom('motionPhoto.presentationOffsetMs must be a non-negative safe integer', { statusCode: 400 })
        }

        const userJid = authState.creds.me.id
        const pairedMediaType = WAProto_1.proto.ContextInfo.PairedMediaType
        const associationType = WAProto_1.proto.MessageAssociation.AssociationType
        const mediaOptions = {
            logger,
            userJid,
            jid,
            newsletter: WABinary_1.isJidNewsletter(jid),
            upload: (encFilePath, uploadOptions) => waUploadToServer(encFilePath, {
                ...uploadOptions,
                newsletter: WABinary_1.isJidNewsletter(jid)
            }),
            mediaCache: config.mediaCache,
            options: config.options
        }

        const preparedImage = await Utils_1.prepareWAMessageMedia({
            image: content.image,
            ...(content.caption !== undefined ? { caption: content.caption } : {})
        }, mediaOptions)
        const preparedVideo = await Utils_1.prepareWAMessageMedia({
            video: content.video,
            ...(content.videoCaption !== undefined ? { caption: content.videoCaption } : {})
        }, mediaOptions)

        const imageMessage = preparedImage.imageMessage
        const videoMessage = preparedVideo.videoMessage
        if (!imageMessage || !videoMessage) {
            throw new boom_1.Boom('Could not prepare motion photo image and video media', { statusCode: 500 })
        }

        imageMessage.contextInfo = {
            ...(content.contextInfo || {}),
            pairedMediaType: pairedMediaType.MOTION_PHOTO_PARENT
        }
        videoMessage.contextInfo = {
            ...(videoMessage.contextInfo || {}),
            pairedMediaType: pairedMediaType.MOTION_PHOTO_CHILD
        }
        videoMessage.motionPhotoPresentationOffsetMs = presentationOffsetMs

        const parentMessage = Utils_1.generateWAMessageFromContent(jid, {
            messageContextInfo: {},
            imageMessage
        }, {
            userJid,
            quoted: options.quoted,
            ephemeralExpiration: options.ephemeralExpiration,
            messageId: options.messageId || Utils_1.generateMessageID(userJid)
        })

        const childMessage = Utils_1.generateWAMessageFromContent(jid, {
            messageContextInfo: {
                messageAssociation: {
                    associationType: associationType.MOTION_PHOTO,
                    parentMessageKey: parentMessage.key
                }
            },
            associatedChildMessage: {
                message: { videoMessage }
            }
        }, {
            userJid,
            ephemeralExpiration: options.ephemeralExpiration,
            messageId: Utils_1.generateMessageID(userJid)
        })

        const relayOptions = {
            participant: options.deviceJid ? { jid: options.deviceJid } : undefined,
            useCachedGroupMetadata: options.useCachedGroupMetadata,
            statusJidList: options.statusJidList,
            additionalNodes: options.additionalNodes,
            AI: options.ai,
            syncToOwnDevices: options.syncToOwnDevices
        }

        await relayMessage(jid, parentMessage.message, {
            ...relayOptions,
            messageId: parentMessage.key.id
        })
        if (config.emitOwnEvents) {
            process.nextTick(() => processingMutex.mutex(() => upsertMessage(parentMessage, 'append')))
        }

        await relayMessage(jid, childMessage.message, {
            ...relayOptions,
            messageId: childMessage.key.id
        })
        if (config.emitOwnEvents) {
            process.nextTick(() => processingMutex.mutex(() => upsertMessage(childMessage, 'append')))
        }

        return { parent: parentMessage, child: childMessage }
    }

    const sock = {
        ...baseSock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        profilePictureUrl,
        getUSyncDevices,
        refreshMediaConn,
        waUploadToServer,
        getEphemeralGroup,
        fetchPrivacySettings,
        messageRetryManager,
        createParticipantNodes,
        sendPeerDataOperationMessage,
        updateMemberLabel,
        updateMediaMessage: async (message) => {
            const content = Utils_1.assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await Utils_1.encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error = undefined

            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id)
                    if (result) {
                        if (result.error) {
                            error = result.error
                        }

                        else {
                            try {
                                const media = await Utils_1.decryptMediaRetryData(result.media, mediaKey, result.key.id)

                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result]

                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, { data: media, statusCode: Utils_1.getStatusCodeForMediaRetry(media.result) || 404 })
                                }

                                content.directPath = media.directPath

                                content.url = Utils_1.getUrlFromDirectPath(content.directPath)

                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
                            }

                            catch (err) {
                                error = err
                            }
                        }

                        return true
                    }
                })
            ])

            if (error) {
                throw error
            }

            ev.emit('messages.update', [
                { key: message.key, update: { message: message.message } }
            ])

            return message
        },
        sendStatusMentions: async (content, jids = [], statusJidList = null) => {
            const userJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
            const mentionedUsers = new Set([userJid])

            for (const id of jids) {
                const isGroup = WABinary_1.isJidGroup(id)
                const isPrivate = WABinary_1.isJidUser(id)

                if (isGroup) {
                    try {
                        const metadata = await cachedGroupMetadata(id) || await groupMetadata(id)
                        const participants = await normalizeGroupParticipants(metadata.participants, metadata.addressingMode)
                        participants.forEach(jid => mentionedUsers.add(WABinary_1.jidNormalizedUser(jid)))
                    } catch (error) {
                        logger.error(`Error getting metadata for group ${id}: ${error}`)
                    }
                } else if (isPrivate) {
                    mentionedUsers.add(WABinary_1.jidNormalizedUser(id))
                }
            }

            const uniqueUsers = statusJidList == null
                ? Array.from(mentionedUsers)
                : Array.from(new Set([userJid, ...statusJidList.map(jid => WABinary_1.jidNormalizedUser(jid))]))
            const getRandomHexColor = () => "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")

            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio

            const messageContent = { ...content }

            if (isMedia && !isAudio) {
                if (messageContent.text) {
                    messageContent.caption = messageContent.text

                    delete messageContent.text
                }

                delete messageContent.ptt
                delete messageContent.font
                delete messageContent.backgroundColor
                delete messageContent.textColor
            }

            if (isAudio) {
                delete messageContent.text
                delete messageContent.caption
                delete messageContent.font
                delete messageContent.textColor
            }

            const font = !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined
            const textColor = !isMedia ? (content.textColor || getRandomHexColor()) : undefined
            const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHexColor()) : undefined
            const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

            let msg
            let mediaHandle
            try {
                msg = await Utils_1.generateWAMessage(WABinary_1.STORIES_JID, messageContent, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: { timeout: 3000, ...axiosOptions || {} },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, { ...opts })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    font,
                    textColor,
                    backgroundColor,
                    ptt
                })
            } catch (error) {
                logger.error(`Error generating message: ${error}`)
                throw error
            }

            await relayMessage(WABinary_1.STORIES_JID, msg.message, {
                messageId: msg.key.id,
                statusJidList: uniqueUsers,
                additionalNodes: [
                    {
                        tag: 'meta',
                        attrs: {},
                        content: [
                            {
                                tag: 'mentioned_users',
                                attrs: {},
                                content: jids.map(jid => ({
                                    tag: 'to',
                                    attrs: { jid: WABinary_1.jidNormalizedUser(jid) }
                                }))
                            }]
                    }]
            })

            for (const id of jids) {
                try {
                    const normalizedId = WABinary_1.jidNormalizedUser(id)
                    const isPrivate = WABinary_1.isJidUser(normalizedId)
                    const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'

                    const protocolMessage = {
                        [type]: {
                            message: {
                                protocolMessage: {
                                    key: msg.key,
                                    type: 25
                                }
                            }
                        },
                        messageContextInfo: {
                            messageSecret: crypto_1.randomBytes(32)
                        }
                    }

                    const statusMsg = await Utils_1.generateWAMessageFromContent(normalizedId,
                        protocolMessage,
                        {}
                    )

                    await relayMessage(
                        normalizedId,
                        statusMsg.message,
                        {
                            additionalNodes: [{
                                tag: 'meta',
                                attrs: isPrivate ?
                                    { is_status_mention: 'true' } :
                                    { is_group_status_mention: 'true' }
                            }]
                        }
                    )

                    await Utils_1.delay(2000)
                } catch (error) {
                    logger.error(`Error sending to ${id}: ${error}`)
                }
            }

            return msg
        },
        sendTable: async (jid, headers = ['A', 'B'], rows= [['c', '10'], ['d', '5']], quoted = null, options = {}) => {
            const title = typeof options.title === 'string' ? options.title.trim() : ""
            const { message, messageId } = message_composer_1.generateTableContent(title, headers, rows, quoted, options)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendList: async (jid, list = ["A", "B", "C"], quoted = null, options = {}) => {
            const title = typeof options.title === 'string' ? options.title.trim() : ""
            const { message, messageId } = message_composer_1.generateListContent(title, list, quoted, options)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendCode: async (jid, code = 'const answer = "MidSoune"\nconsole.log(answer)', quoted, options = {}) => {
            const { message, messageId } = message_composer_1.generateCodeBlockContent(code, quoted, options)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendMarkdown: async (jid, text =  '# عنوان\nنص **عريض** مع [رابط](https://example.com)', quoted, options = {}) => {
            const { message, messageId } = message_composer_1.generateMarkdownContent(text, quoted, options)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendEquation: async (jid, equation = 'x^2 + y^2 = z^2', quoted = null, options = {}) => {
            let formulas = []
            if (typeof renderLatexToPng === 'string') {
                formulas.push(renderLatexToPng)
            } else if (renderLatexToPng && typeof renderLatexToPng === 'object') {
                if (renderLatexToPng.formula) {
                    formulas.push(renderLatexToPng.formula)
                } else if (renderLatexToPng.latex) {
                    formulas.push(renderLatexToPng.latex)
                } else if (renderLatexToPng.expressions && Array.isArray(renderLatexToPng.expressions)) {
                    renderLatexToPng.expressions.forEach(e => {
                        if (typeof e === 'string') formulas.push(e)
                        else if (e && e.latexExpression) formulas.push(e.latexExpression)
                    })
                } else if (renderLatexToPng.text) {
                    formulas.push(renderLatexToPng.text)
                }
            } else if (Array.isArray(renderLatexToPng)) {
                renderLatexToPng.forEach(e => {
                    if (typeof e === 'string') formulas.push(e)
                    else if (e && e.latexExpression) formulas.push(e.latexExpression)
                })
            }

            if (formulas.length === 0) {
                formulas.push('E=mc^2')
            }

            const renderFn = message_composer_1.renderLatexToPng

            const uploadToWA = (async (buffer) => message_composer_1.uploadUnencryptedToWA(buffer, waUploadToServer))

            const safeRender = async (expr) => {
                const res = await renderFn(expr)
                if (Buffer.isBuffer(res)) {
                    return { buffer: res, width: 1200, height: 600 }
                } else if (res && Buffer.isBuffer(res.buffer)) {
                    return res
                } else {
                    throw new Error("renderLatexToPng must return a Buffer or an object containing a buffer")
                }
            }

            const safeUpload = async (buffer, type) => {
                const res = await uploadToWA(buffer, type)
                if (typeof res === 'string') {
                    return { url: res }
                } else {
                    return res
                }
            }

            const composerOptions = {
                text: typeof options.text === 'string' ? options.text : '',
                headerText: typeof options.headerText === 'string' ? options.headerText : renderLatexToPng?.headerText,
                footer: typeof options.footer === 'string' ? options.footer : renderLatexToPng?.footer,
                expressions: formulas.map(formula => ({ latexExpression: formula }))
            }

            const { message, messageId } = await message_composer_1.generateLatexInlineImageContent(quoted, composerOptions, safeUpload, safeRender)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendHtml: async (jid, html = '<div><h1>Mid<soune</h1><p>Hi HTML</p></div>', quoted = null, additionalOptions = {}) => {
            let opts
            if (typeof html === 'string') {
                opts = { ...additionalOptions }
            } else if (html && typeof html === 'object') {
                html = html.html || ''
                opts = { ...additionalOptions }
            } else {
                throw new Error('[sendRichHtml] options or html content must be provided')
            }

            return rich_message_utils_1.sendRichHtml(
                relayMessage,
                jid,
                { ...opts, html },
                quoted,
                additionalOptions
            )
        },
        sendRichMessage: async (jid, submessages, quoted, options = {}) => {
            const { message, messageId } = message_composer_1.generateRichMessageContent(submessages, quoted, options)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        captureUnifiedResponse: message_composer_1.captureUnifiedResponse,
        getFile: Utils_1.getFile,
        sendFile: async (jid, pathSource, filename = '', caption = '', quoted = null, ptt = false, options = {}) => {
            const fileInfo = await Utils_1.getFile(pathSource, true)
            const { asSticker, asDocument, asImage, mimetype: requestedMimeType, ...sendOptions } = options
            delete sendOptions.asVideo
            delete sendOptions.asLocation
            const mimeType = requestedMimeType || fileInfo.mime
            let messageType

            if ((mimeType === 'image/webp' && !asImage) || (mimeType.startsWith('image/') && asSticker)) {
                messageType = 'sticker'
            } else if (mimeType.startsWith('image/')) {
                messageType = 'image'
            } else if (mimeType.startsWith('video/')) {
                messageType = 'video'
            } else if (mimeType.startsWith('audio/')) {
                messageType = 'audio'
            } else {
                messageType = 'document'
            }

            if (asDocument) messageType = 'document'

            const resolvedFileName = filename || (fileInfo.filename ? path_1.basename(fileInfo.filename) : 'file')
            const message = {
                ...sendOptions,
                caption,
                ...(messageType === 'audio' ? { ptt } : {}),
                [messageType]: { url: fileInfo.filename },
                mimetype: messageType === 'audio' ? (requestedMimeType || 'audio/mpeg; codecs=opus') : mimeType,
                fileName: resolvedFileName
            }
            const sendMessageOptions = { ...sendOptions, ...(quoted ? { quoted } : {}) }

            try {
                try {
                    return await sock.sendMessage(jid, message, sendMessageOptions)
                } catch (error) {
                    logger.warn({ err: error }, 'Error sending media by file path; retrying with buffer')
                    return await sock.sendMessage(jid, { ...message, [messageType]: fileInfo.data }, sendMessageOptions)
                }
            } finally {
                await fileInfo.deleteFile()
            }
        },
        reply: async (jid, text = '', quoted = null, options = {}) => {
            if (Buffer.isBuffer(text)) {
                return await sock.sendFile(jid, text, options.fileName || 'file', options.caption || '', quoted, false, options)
            }

            return await sock.sendMessage(jid, { ...options, text }, { ...options, ...(quoted ? { quoted } : {}) })
        },
        forward: async (jid, message, forwardingScore = false, options = {}) => {
            const { readViewOnce, ...generationOptions } = options
            let sourceMessage = message
            let messageType

            if (readViewOnce && message.message?.viewOnceMessage?.message) {
                const viewOnceContent = JSON.parse(JSON.stringify(message.message.viewOnceMessage.message))
                messageType = Object.keys(viewOnceContent)[0]
                if (!messageType) return

                if (viewOnceContent[messageType] && typeof viewOnceContent[messageType] === 'object') {
                    delete viewOnceContent[messageType].viewOnce
                }
                sourceMessage = {
                    ...message,
                    message: {
                        ...message.message,
                        viewOnceMessage: {
                            ...message.message.viewOnceMessage,
                            message: viewOnceContent
                        }
                    }
                }
                sourceMessage.message = WAProto_1.proto.Message.fromObject(viewOnceContent)
                sourceMessage.message[messageType].contextInfo = message.message.viewOnceMessage.contextInfo || {}
            }

            messageType = Object.keys(sourceMessage.message || {})[0]
            if (!messageType) return

            const forwardedContent = Utils_1.generateForwardMessageContent(sourceMessage, !!forwardingScore)
            const contentType = Object.keys(forwardedContent)[0]
            if (!contentType || !forwardedContent[contentType]) return

            if (!forwardedContent[contentType].contextInfo) forwardedContent[contentType].contextInfo = {}
            if (typeof forwardingScore === 'number' && forwardingScore > 1) {
                forwardedContent[contentType].contextInfo.forwardingScore =
                    (forwardedContent[contentType].contextInfo.forwardingScore || 0) + forwardingScore
                forwardedContent[contentType].contextInfo.isForwarded = true
            }
            forwardedContent[contentType].contextInfo = {
                ...(sourceMessage.message[messageType]?.contextInfo || {}),
                ...forwardedContent[contentType].contextInfo
            }

            const forwardedMessage = Utils_1.generateWAMessageFromContent(jid, forwardedContent, {
                ...generationOptions,
                userJid: sock.user?.id || authState.creds.me?.id
            })
            await sock.relayMessage(jid, forwardedMessage.message, {
                ...generationOptions,
                messageId: forwardedMessage.key.id
            })
            return forwardedMessage
        },
        fakeReply: async (jid, fakeText = '', text = '',  fakeJid, fakeGroupJid, options = {}) => {
            let quotedMessage = null;
            if (Buffer.isBuffer(fakeText)) {
                const fileInfo = await sock.getFile(fakeText)
                if (fileInfo.mime.startsWith('image/')) {
                    const { buffer: jpegThumbnail } = await Utils_1.extractImageThumb(fileInfo.data, 32)
                    quotedMessage = {
                        imageMessage: {
                            mimetype: fileInfo.mime,
                            jpegThumbnail
                        }
                    }
                }
            }

            return await sock.reply(jid, text, {
                key: {
                    fromMe: WABinary_1.areJidsSameUser(fakeJid, sock.user?.id),
                    participant: WABinary_1.isJidGroup(jid) ? fakeJid : null,
                    remoteJid: jid,
                    id: `A68E-${crypto_1.randomBytes(8).toString('hex').toUpperCase()}`
                },
                message: quotedMessage || { conversation: fakeText }
            }, options)
        },
        downloadM: async (message, type, saveToFile) => {
            if (!message || !(message.url || message.directPath)) return Buffer.alloc(0)
            const stream = await Utils_1.downloadContentFromMessage(message, type)
            const buffer = await Utils_1.toBuffer(stream)
            if (!saveToFile) return buffer

            const { filename } = await sock.getFile(buffer, true)
            return filename
        },
        sendUnifiedResponse: async (jid, quoted, captured) => {
            const { message, messageId } = message_composer_1.generateUnifiedResponseContent(quoted, captured)
            await relayMessage(jid, message, { messageId })
            return { message, messageId }
        },
        sendMetaStep,
        sendMessage: async (jid, content, options = {}) => {
            let targetJid = jid
            if (typeof jid === 'object' && jid !== null && 'type' in jid) {
                if (jid.type === 'username') {
                    const resolution = await (sock.resolveUsername || resolveUsername)(jid.username)
                    if (!resolution || (!resolution.lid && !resolution.pn && !resolution.jid)) {
                        throw new Types_1.UsernameNotFoundError(jid.username)
                    }
                    targetJid = resolution.lid || resolution.pn || resolution.jid
                } else if (jid.type === 'jid') {
                    targetJid = jid.jid
                } else {
                    throw new Types_1.UsernameInvalidError(String(jid), 'Invalid target object type')
                }
            } else if (typeof jid === 'string') {
                const trimmed = jid.trim()
                if (trimmed.startsWith('@') && trimmed.length > 1) {
                    const resolution = await (sock.resolveUsername || resolveUsername)(trimmed)
                    if (!resolution || (!resolution.lid && !resolution.pn && !resolution.jid)) {
                        throw new Types_1.UsernameNotFoundError(trimmed)
                    }
                    targetJid = resolution.lid || resolution.pn || resolution.jid
                }
            }

            jid = targetJid
            const userJid = authState.creds.me.id
            const additionalAttributes = {}

            if (!options.ephemeralExpiration) {
                if (WABinary_1.isJidGroup(jid)) {
                    const expiration = await getEphemeralGroup(jid)
                    options.ephemeralExpiration = expiration
                }
            }

            if (typeof content === 'object' && content !== null && 'photoPoll' in content) {
                const photoPoll = content.photoPoll || {}
                const values = Array.isArray(photoPoll.values) ? photoPoll.values : photoPoll.options
                if (typeof photoPoll.name !== 'string' || !photoPoll.name.trim() ||
                    !Array.isArray(values) || values.length < 2) {
                    throw new boom_1.Boom('photoPoll needs a name and at least two values', { statusCode: 400 })
                }

                const selectableCount = photoPoll.selectableCount ?? 1
                if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > values.length) {
                    throw new boom_1.Boom(`photoPoll.selectableCount must be between 1 and ${values.length}`, { statusCode: 400 })
                }

                const normalizedOptions = values.map((option, index) => {
                    if (typeof option?.name !== 'string' || !option.name.trim() || option.image == null) {
                        throw new boom_1.Boom(`photoPoll.values[${index}] needs a name and image`, { statusCode: 400 })
                    }
                    return { name: option.name, image: option.image }
                })
                if (new Set(normalizedOptions.map(option => option.name)).size !== normalizedOptions.length) {
                    throw new boom_1.Boom('photoPoll option names must be unique', { statusCode: 400 })
                }

                const messageSecret = photoPoll.messageSecret === undefined
                    ? undefined
                    : Buffer.from(photoPoll.messageSecret)
                if (messageSecret && messageSecret.length !== 32) {
                    throw new boom_1.Boom('photoPoll.messageSecret must be exactly 32 bytes', { statusCode: 400 })
                }

                return Utils_1.generateWAMessageFromImagePoll(jid, {
                    name: photoPoll.name,
                    selectableCount,
                    options: normalizedOptions,
                    messageSecret
                }, (message, relayOptions) => relayMessage(jid, message, {
                    ...relayOptions,
                    participant: options.deviceJid ? { jid: options.deviceJid } : undefined,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    AI: options.ai,
                    syncToOwnDevices: options.syncToOwnDevices
                }), {
                    logger,
                    userJid,
                    messageId: options.messageId,
                    quoted: options.quoted,
                    upload: async (encFilePath, uploadOptions) => waUploadToServer(encFilePath, {
                        ...uploadOptions,
                        newsletter: WABinary_1.isJidNewsletter(jid)
                    }),
                    mediaCache: config.mediaCache,
                    options: config.options,
                    additionalNodes: options.additionalNodes,
                    onMessageSent: config.emitOwnEvents
                        ? message => process.nextTick(() => processingMutex.mutex(() => upsertMessage(message, 'append')))
                        : undefined
                })
            }

            else if (typeof content === 'object' && content !== null && 'motionPhoto' in content) {
                return sendMotionPhoto(jid, content.motionPhoto, options)
            }

            else if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                WABinary_1.isJidGroup(jid)) {

                const { disappearingMessagesInChat } = content

                const value = typeof disappearingMessagesInChat === 'boolean' ?
                    (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
                    disappearingMessagesInChat

                await groupToggleEphemeral(jid, value)
            }

            else if (typeof content === 'object' && 'album' in content && content.album) {
                const albumMsg = await Utils_1.prepareAlbumMessageContent(jid, content.album, {
                    sock: {
                        relayMessage,
                        waUploadToServer
                    },
                    userJid: userJid,
                    ...options
                })

                for (const media of albumMsg) {
                    await Utils_1.delay(options.delay || 500)
                    await (sock.relayMessage || relayMessage)(jid, media.message, { messageId: media.key.id, participant: options.deviceJid ? { jid: options.deviceJid } : undefined, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, statusJidList: options.statusJidList, additionalNodes: options.additionalNodes, AI: options.ai, syncToOwnDevices: options.syncToOwnDevices })
                }

                return albumMsg
            }

            else {
                let mediaHandle

                const fullMsg = await Utils_1.generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview
                            ? waUploadToServer
                            : undefined
                    }),
                    getProfilePicUrl: profilePictureUrl,
                    getCallLink: createCallLink,
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, { ...opts, newsletter: WABinary_1.isJidNewsletter(jid) })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    getMessage: config.getMessage,
                    userLid: authState.creds.me?.lid,
                    messageId: (content?.groupStatus && !options.messageId)
                        ? `3EB0${crypto_1.randomBytes(16).toString('hex').toUpperCase()}`
                        : Utils_1.generateMessageID(userJid),
                    ...options,
                })

                const isPin = 'pin' in content && !!content.pin
                const isEdit = 'edit' in content && !!content.edit
                const isDelete = 'delete' in content && !!content.delete
                const isKeep = 'keep' in content && !!content.keep && content.keep?.type === 2

                if (isDelete || isKeep) {
                    // if the chat is a group, and I am not the author, then delete the message as an admin
                    if (WABinary_1.isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe || WABinary_1.isJidNewsletter(jid)) {
                        additionalAttributes.edit = '8'
                    }

                    else {
                        additionalAttributes.edit = '7'
                    }
                }

                else if (isEdit) {
                    additionalAttributes.edit = WABinary_1.isJidNewsletter(jid) ? '3' : '1'
                }

                else if (isPin) {
                    additionalAttributes.edit = '2'
                }

                if (mediaHandle) {
                    additionalAttributes['media_id'] = mediaHandle
                }

                if ('cachedGroupMetadata' in options) {
                    logger.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.')
                }

                const isNeedBizAttrs = typeof content === 'object' && content && 'secureMetaServiceLabel' in content && !!content.secureMetaServiceLabel

                await (sock.relayMessage || relayMessage)(jid, fullMsg.message, { messageId: fullMsg.key.id, participant: options.deviceJid ? { jid: options.deviceJid } : undefined, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, statusJidList: options.statusJidList, additionalNodes: options.additionalNodes, AI: options.ai, addBizAttributes: isNeedBizAttrs, syncToOwnDevices: options.syncToOwnDevices })

                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        processingMutex.mutex(() => (upsertMessage(fullMsg, 'append')))
                    })
                }

                return fullMsg
            }
        },
        deleteStory: async (id, statusJidList = []) => {
            return await sock.sendMessage('status@broadcast', { delete: { remoteJid: 'status@broadcast', fromMe: true, id } }, { statusJidList })
       },
        sendNewsletterStatus: async (jid, options = {}) => {
         const sendStatus = Utils_1.makeNewsletterStatusSender(sock, { logger }, waUploadToServer)
         return sendStatus(jid, options)
        }
    }
    config.messageSocket = sock
    return sock
}

module.exports = { makeMessagesSocket }
