"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const WAProto_1 = require("../../WAProto")
const Types_1 = require("../Types")
const messages_1 = require("../Utils/messages")
const WABinary_1 = require("../WABinary")
const crypto_1 = require("./crypto")
const generics_1 = require("./generics")
const history_1 = require("./history")

const REAL_MSG_STUB_TYPES = new Set([
    Types_1.WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
    Types_1.WAMessageStubType.CALL_MISSED_GROUP_VOICE,
    Types_1.WAMessageStubType.CALL_MISSED_VIDEO,
    Types_1.WAMessageStubType.CALL_MISSED_VOICE
])

const REAL_MSG_REQ_ME_STUB_TYPES = new Set([
    Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD
])

/** Cleans a received message to further processing */
const cleanMessage = (message, meId, meLid) => {
    // ensure remoteJid and participant doesn't have device or agent in it
    message.key.remoteJid = WABinary_1.jidNormalizedUser(message.key.remoteJid)
    message.key.participant = message.key.participant ? WABinary_1.jidNormalizedUser(message.key.participant) : undefined
    const content = messages_1.normalizeMessageContent(message.message)
    // if the message has a reaction, ensure fromMe & remoteJid are from our perspective
    if (content?.reactionMessage) {
        normaliseKey(content.reactionMessage.key)
    }
    if (content?.pollUpdateMessage) {
        normaliseKey(content.pollUpdateMessage.pollCreationMessageKey)
    }
    if (content?.eventResponseMessage) {
        normaliseKey(content.eventResponseMessage.eventResponseMessageKey)
    }
    function normaliseKey(msgKey) {
        // if the reaction is from another user
        // we've to correctly map the key to this user's perspective
        if (!message.key.fromMe) {
            // if the sender believed the message being reacted to is not from them
            // we've to correct the key to be from them, or some other participant
            msgKey.fromMe = WABinary_1.areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) || (!!meLid && WABinary_1.areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid))
            // set the remoteJid to being the same as the chat the message came from
            msgKey.remoteJid = message.key.remoteJid
            // set participant of the message
            msgKey.participant = msgKey.participant || message.key.participant
        }
    }
}

const isRealMessage = (message, meId, meLid) => {
    const normalizedContent = messages_1.normalizeMessageContent(message.message)
    const hasSomeContent = !!messages_1.getContentType(normalizedContent)
    return (
        !!normalizedContent ||
        REAL_MSG_STUB_TYPES.has(message.messageStubType) ||
        (
            REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType) &&
            message.messageStubParameters?.some(p => WABinary_1.areJidsSameUser(meId, p) || (!!meLid && WABinary_1.areJidsSameUser(meLid, p)))
        )
    ) &&
        hasSomeContent &&
        !normalizedContent?.protocolMessage &&
        !normalizedContent?.reactionMessage &&
        !normalizedContent?.pollUpdateMessage
}

const shouldIncrementChatUnread = (message) => (!message.key.fromMe && !message.messageStubType)

/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
const getChatId = ({ remoteJid, participant, fromMe }) => {
    if (WABinary_1.isJidBroadcast(remoteJid)
        && !WABinary_1.isJidStatusBroadcast(remoteJid)
        && !fromMe) {
        return participant
    }
    return remoteJid
}

/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
 const toBytes = (value, label) => {
    if (!value) {
        throw new Error(`[CRITICAL] ${label} is undefined or empty! Check your message structure.`);
    }
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (Array.isArray(value)) return Buffer.from(value);
    if (typeof value === 'string' && value.length) return Buffer.from(value, 'base64');
    throw new Error(`${label} must be a non-empty Buffer, Uint8Array, Array, or Base64 string`);
}
function decryptPollVote({ encPayload, encIv }, { pollCreatorLid, pollMsgId, pollEncKey, voterLid }) {
    try {
        // 1. تحويل المدخلات وتوثيقها
        const payloadBuffer = toBytes(encPayload, 'encPayload');
        const ivBuffer = toBytes(encIv, 'encIv');
        const keyBuffer = toBytes(pollEncKey, 'messageSecret');

        // 2. بناء التوقيع (Sign)
        const sign = Buffer.concat([
            toBinary(pollMsgId),
            toBinary(pollCreatorLid),
            toBinary(voterLid),
            toBinary('Poll Vote'),
            new Uint8Array([1])
        ]);

        const key0 = crypto_1.hmacSign(keyBuffer, new Uint8Array(32), 'sha256');
        const decKey = crypto_1.hmacSign(sign, key0, 'sha256');
        const aad = toBinary(`${pollMsgId}\u0000${voterLid}`);
        const decrypted = crypto_1.aesDecryptGCM(payloadBuffer, decKey, ivBuffer, aad);
        return WAProto_1.proto.Message.PollVoteMessage.decode(decrypted);

    } catch (error) {
        console.error("❌ [ERROR] Failed to decrypt poll vote!");
        console.error("   - Error Message:", error.message);
        console.error("   - Stack Trace:", error.stack);
        throw error; // إعادة رمي الخطأ باش يكمل المسار الطبيعي ديال الـ catch البرا إيلا بغيتي
    }

    function toBinary(txt) {
        return Buffer.from(txt);
    }
}
/**
 * Decrypts a poll vote from the original poll and vote messages.
 * The voter JID must come from the vote message key or be provided explicitly.
 */
function decryptPollVoteMessage(pollCreationMessage, voteMessage, me) {
    const pollContent = pollCreationMessage?.message || pollCreationMessage
    const voteContent = voteMessage?.message || voteMessage
    const pollUpdate = voteContent?.pollUpdateMessage
    const pollKey = pollUpdate?.pollCreationMessageKey
    const normalizedPollContent = messages_1.normalizeMessageContent(pollContent)
    const pollEncKey = pollCreationMessage?.messageContextInfo?.messageSecret ||
        pollContent?.messageContextInfo?.messageSecret ||
        normalizedPollContent?.messageContextInfo?.messageSecret
    const decodeX = (jid) => {
    if (!jid || typeof jid !== 'string') return jid;
    if (!jid.includes('@')) return jid;
    const [id, server] = jid.split('@');
    const userAgent = id.split(':')[0];
    const user = userAgent.split('_')[0];
    return `${user}@${server}`;
};
    const meLid = decodeX(me.lid) || decodeX(me.id)
    if (!pollUpdate?.vote || !pollKey?.id) {
        throw new Error('Poll vote message is missing pollUpdateMessage data')
    }
    if (pollCreationMessage?.key?.id && pollCreationMessage.key.id !== pollKey.id) {
        throw new Error('Poll creation message does not match pollCreationMessageKey.id')
    }
    if (!pollEncKey) {
        throw new Error('Poll creation message is missing messageContextInfo.messageSecret')
    }
  
    return decryptPollVote(
    {
        encPayload: toBytes(pollUpdate.vote.encPayload, 'encPayload'),
        encIv: toBytes(pollUpdate.vote.encIv, 'encIv')
    },
    {
        pollEncKey: toBytes(pollEncKey, 'messageSecret'),
        pollCreatorLid: meLid,
        pollMsgId: pollKey.id,
        voterLid: pollUpdate.pollCreationMessageKey.remoteJid // أو JID الخاص بالمصوت حسب الحاجة
    }
)
}

/**
 * Decrypt an event edit
 * @param edit encrypted event edit
 * @returns message
 */
function decryptEventEdit({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const sign = Buffer.concat([
        toBinary(eventMsgId),
        toBinary(eventCreatorJid),
        toBinary(responderJid),
        toBinary('Event Edit'),
        new Uint8Array([1])
    ])

    const key0 = crypto_1.hmacSign(eventEncKey, new Uint8Array(32), 'sha256')
    const decKey = crypto_1.hmacSign(sign, key0, 'sha256')
    const decrypted = crypto_1.aesDecryptGCM(encPayload, decKey, encIv, null)

    return WAProto_1.proto.Message.decode(decrypted)

    function toBinary(txt) {
        return Buffer.from(txt)
    }
}

/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const sign = Buffer.concat([
        toBinary(eventMsgId),
        toBinary(eventCreatorJid),
        toBinary(responderJid),
        toBinary('Event Response'),
        new Uint8Array([1])
    ])

    const key0 = crypto_1.hmacSign(eventEncKey, new Uint8Array(32), 'sha256')
    const decKey = crypto_1.hmacSign(sign, key0, 'sha256')
    const aad = toBinary(`${eventMsgId}\u0000${responderJid}`)
    const decrypted = crypto_1.aesDecryptGCM(encPayload, decKey, encIv, aad)

    return WAProto_1.proto.Message.EventResponseMessage.decode(decrypted)

    function toBinary(txt) {
        return Buffer.from(txt)
    }
}

/**
 * Decrypt an comment message 
 * @param comment encrypted comment message
 * @returns message
 */
function decryptComment({ encPayload, encIv }, { commentCreatorJid, commentMsgId, commentEncKey, commentJid }) {
    const sign = Buffer.concat([
        toBinary(commentMsgId),
        toBinary(commentCreatorJid),
        toBinary(commentJid),
        toBinary('Enc Comment'),
        new Uint8Array([1])
    ])

    const key0 = crypto_1.hmacSign(commentEncKey, new Uint8Array(32), 'sha256')
    const decKey = crypto_1.hmacSign(sign, key0, 'sha256')
    const decrypted = crypto_1.aesDecryptGCM(encPayload, decKey, encIv, null)

    return WAProto_1.proto.Message.decode(decrypted)

    function toBinary(txt) {
        return Buffer.from(txt)
    }
}

/**
 * Decrypt an reaction 
 * @param reaction encrypted reaction
 * @returns reaction message
 */
function decryptReaction({ encPayload, encIv }, { reactionCreatorJid, reactionMsgId, reactionEncKey, reactionJid }) {
    const sign = Buffer.concat([
        toBinary(reactionMsgId),
        toBinary(reactionCreatorJid),
        toBinary(reactionJid),
        toBinary('Enc Reaction'),
        new Uint8Array([1])
    ])

    const key0 = crypto_1.hmacSign(reactionEncKey, new Uint8Array(32), 'sha256')
    const decKey = crypto_1.hmacSign(sign, key0, 'sha256')
    const decrypted = crypto_1.aesDecryptGCM(encPayload, decKey, encIv, null)

    return WAProto_1.proto.Message.ReactionMessage.decode(decrypted)

    function toBinary(txt) {
        return Buffer.from(txt)
    }
}

const processMessage = async (message, { shouldProcessHistoryMsg, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }) => {
    const meId = creds.me.id
    const meLid = creds.me.lid
    const { accountSettings } = creds
    const lidToJid = async jid => {
        if (!WABinary_1.isLidUser(jid)) {
            return jid
        }

        const pnJid = await signalRepository?.lidMapping?.getPNForLID(jid)
        return pnJid ? WABinary_1.jidNormalizedUser(pnJid) : jid
    }
    const normalizeKeyJids = async key => {
        if (!key) {
            return key
        }

        const remoteJid = await lidToJid(key.remoteJid)
        const participant = await lidToJid(key.participant)
        const revokedBy = await lidToJid(key.revokedBy)

        return {
            ...key,
            remoteJid,
            ...(remoteJid !== key.remoteJid ? { remoteJidAlt: key.remoteJid } : {}),
            ...(key.participant ? { participant } : {}),
            ...(participant !== key.participant ? { participantAlt: key.participant } : {}),
            ...(key.revokedBy ? { revokedBy } : {})
        }
    }
    const sourceMessageKey = message.key
    const chat = { id: WABinary_1.jidNormalizedUser(getChatId(sourceMessageKey)) }
    const isRealMsg = isRealMessage(message, meId, meLid)
    if (isRealMsg) {
        chat.messages = [{ message }]
        chat.conversationTimestamp = generics_1.toNumber(message.messageTimestamp)
        // only increment unread count if not CIPHERTEXT and from another person
        if (shouldIncrementChatUnread(message)) {
            chat.unreadCount = (chat.unreadCount || 0) + 1
        }
    }
    const content = messages_1.normalizeMessageContent(message.message)
    // unarchive chat if it's a real message, or someone reacted to our message
    // and we've the unarchive chats setting on
    if (isRealMsg || content?.reactionMessage?.key?.fromMe
        && accountSettings?.unarchiveChats) {
        chat.archived = false
        chat.readOnly = false
    }
    const rawProtocolMsg = message.message?.protocolMessage
    const protocolMsg = rawProtocolMsg?.key || rawProtocolMsg?.type != null
        ? rawProtocolMsg
        : content?.protocolMessage
    const secretEdit = message.message?.secretEncryptedMessage || content?.secretEncryptedMessage
    const isSecretMessageEdit = secretEdit?.secretEncType === 2 || secretEdit?.secretEncType === 'MESSAGE_EDIT'
    const isEdited = protocolMsg?.type === WAProto_1.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
        || isSecretMessageEdit
        || (message.attrs?.edit === '1')
    const isDeleted = protocolMsg?.type === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE
        || message.attrs?.edit === '7'

    if (isDeleted) {
        const revokedKey = protocolMsg?.key
        if (revokedKey?.id) {
            const key = await normalizeKeyJids({
                ...revokedKey,
                remoteJid: revokedKey.remoteJid || sourceMessageKey.remoteJid,
                revokedBy: sourceMessageKey.remoteJid,
                revokedByFromMe: sourceMessageKey.fromMe
            })
            ev.emit('messages.delete', { keys: [key] })
        }
    }
    else if (isEdited) {
        const editedKey = secretEdit?.targetMessageKey || protocolMsg?.key
        if (!editedKey?.id) {
            logger?.warn({ messageKey: message.key }, 'message edit target key missing, cannot apply update')
        }
        else {
            const key = await normalizeKeyJids({
                ...editedKey,
                id: editedKey.id
            })
            let editedContent = protocolMsg?.editedMessage

            if (isSecretMessageEdit) {
                try {
                    message.key.remoteJidAlt = editedKey.remoteJid === message.key.remoteJid ? undefined : editedKey.remoteJid;
                    const originalMessage = await getMessage?.(editedKey) || await getMessage?.(key)
                    if (!originalMessage) {
                        logger?.warn({ key }, 'message edit target not found, cannot decrypt update')
                    }
                    else {
                        editedContent = await messages_1.decryptEditMessageContent(message, originalMessage)
                        if (!editedContent) {
                            logger?.warn({ key }, 'message edit decryption did not produce message content')
                        }
                    }
                }
                catch (err) {
                    logger?.warn({ err, key }, 'failed to decrypt message edit')
                }
            }

            ev.emit('messages.update', [{
                key,
                update: {
                    status: 1,
                    ...(editedContent ? { message: editedContent } : {}),
                    messageEdit: {
                        ...message.message,
                        targetMessageKey: key,
                        encrypted: isSecretMessageEdit,
                        contentAvailable: Boolean(editedContent)
                    },
                    messageTimestamp: protocolMsg?.timestampMs
                        ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
                        : message.messageTimestamp
                }
            }])
        }
    }
    else if (protocolMsg) {
        switch (protocolMsg.type) {
            case WAProto_1.proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
                const histNotification = protocolMsg.historySyncNotification
                const process = shouldProcessHistoryMsg
                const isLatest = !creds.processedHistoryMessages?.length
                logger?.info({
                    histNotification,
                    process,
                    id: message.key.id,
                    isLatest,
                }, 'got history notification')
                if (process) {
                    if (histNotification.syncType !== WAProto_1.proto.HistorySync.HistorySyncType.ON_DEMAND) {
                        ev.emit('creds.update', {
                            processedHistoryMessages: [
                                ...(creds.processedHistoryMessages || []),
                                { key: message.key, messageTimestamp: message.messageTimestamp }
                            ]
                        })
                    }
                    const data = await history_1.downloadAndProcessHistorySyncNotification(histNotification, options, logger)

                    if (data.lidPnMappings?.length) {
                        logger?.debug({ count: data.lidPnMappings.length }, 'processing LID-PN mappings from history sync')
                        await signalRepository.lidMapping
                            .storeLIDPNMappings(data.lidPnMappings)
                            .catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'))
                    }

                    // patch auto-persist tcToken from history-sync chats for 463 prevention
                    if (data.chats?.length) {
                        const tctokenSet = {}
                        for (const c of data.chats) {
                            if (c?.tcToken && c?.id) {
                                const buf = Buffer.isBuffer(c.tcToken) ? c.tcToken : Buffer.from(c.tcToken)
                                if (buf.length) {
                                    tctokenSet[c.id] = {
                                        token: buf,
                                        timestamp: c.tcTokenTimestamp ? String(c.tcTokenTimestamp) : undefined
                                    }
                                }
                            }
                        }
                        if (Object.keys(tctokenSet).length) {
                            try {
                                await keyStore.set({ 'tctoken': tctokenSet })
                                logger?.info({ count: Object.keys(tctokenSet).length }, '[wsapme] persisted tctoken(s) from history sync')
                            } catch (err) {
                                logger?.warn({ err: err?.message }, '[wsapme] failed to persist tctoken from history sync')
                            }
                        }
                    }

                    ev.emit('messaging-history.set', {
                        ...data,
                        isLatest: histNotification.syncType !== WAProto_1.proto.HistorySync.HistorySyncType.ON_DEMAND
                            ? isLatest
                            : undefined,
                        peerDataRequestSessionId: histNotification.peerDataRequestSessionId
                    })
                }
                break
            case WAProto_1.proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
                const keys = protocolMsg.appStateSyncKeyShare.keys
                if (keys?.length) {
                    let newAppStateSyncKeyId = ''
                    await keyStore.transaction(async () => {
                        const newKeys = []
                        for (const { keyData, keyId } of keys) {
                            const strKeyId = Buffer.from(keyId.keyId).toString('base64')
                            newKeys.push(strKeyId)
                            await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
                            newAppStateSyncKeyId = strKeyId
                        }
                        logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys')
                    }, meId)
                    ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
                }
                else {
                    logger?.info({ protocolMsg }, 'recv app state sync with 0 keys')
                }
                break
            case WAProto_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
                Object.assign(chat, {
                    ephemeralSettingTimestamp: generics_1.toNumber(message.messageTimestamp),
                    ephemeralExpiration: protocolMsg.ephemeralExpiration || null
                })
                break
            case WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
                const response = protocolMsg.peerDataOperationRequestResponseMessage
                if (response) {
                    // TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
                    const peerDataOperationResult = response.peerDataOperationResult || []
                    for (const result of peerDataOperationResult) {
                        const retryResponse = result?.placeholderMessageResendResponse
                        //eslint-disable-next-line max-depth
                        if (!retryResponse?.webMessageInfoBytes) {
                            continue
                        }

                        //eslint-disable-next-line max-depth
                        try {
                            const webMessageInfo = WAProto_1.proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes)
                            const msgId = webMessageInfo.key?.id
                            // Retrieve cached original message data (preserves LID details,
                            // timestamps, etc. that the phone may omit in its PDO response)
                            const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined
                            //eslint-disable-next-line max-depth
                            if (msgId) {
                                await placeholderResendCache?.del(msgId)
                            }

                            let finalMsg
                            //eslint-disable-next-line max-depth
                            if (cachedData && typeof cachedData === 'object') {
                                // Apply decoded message content onto cached metadata (preserves LID etc.)
                                cachedData.message = webMessageInfo.message
                                //eslint-disable-next-line max-depth
                                if (webMessageInfo.messageTimestamp) {
                                    cachedData.messageTimestamp = webMessageInfo.messageTimestamp
                                }
                                finalMsg = cachedData
                            } else {
                                finalMsg = webMessageInfo
                            }

                            logger?.debug({ msgId, requestId: response.stanzaId }, 'received placeholder resend')

                            ev.emit('messages.upsert', {
                                messages: [finalMsg],
                                type: 'notify',
                                requestId: response.stanzaId
                            })
                        } catch (err) {
                            logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response')
                        }
                    }
                }
                break
            case WAProto_1.proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
                const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload
                const { pnToLidMappings, chatDbMigrationTimestamp } = WAProto_1.proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)

                logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp')

                const pairs = []

                for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
                    const lid = latestLid || assignedLid
                    pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })
                }

                await signalRepository.lidMapping.storeLIDPNMappings(pairs)
                if (pairs.length) {
                    for (const { pn, lid } of pairs) {
                        await signalRepository.migrateSession(pn, lid)
                    }
                }
                break
            case WAProto_1.proto.Message.ProtocolMessage.Type.LIMIT_SHARING:
                ev.emit('limit-sharing.update', {
                    id: message.key.remoteJid,
                    author: WABinary_1.areJidsSameUser(message.key.remoteJid, protocolMsg.key.remoteJid) ? WABinary_1.jidNormalizedUser(meId) : message.key.remoteJid,
                    action: `${protocolMsg.limitSharing.sharingLimited ? 'on' : 'off'}`,
                    trigger: protocolMsg.limitSharing.trigger,
                    update_time: protocolMsg.limitSharing.limitSharingSettingTimestamp
                })
                break
        }
    }
    else if (content?.reactionMessage) {
        const reaction = {
            ...content.reactionMessage,
            key: message.key,
        }
        ev.emit('messages.reaction', [{
            reaction,
            key: content.reactionMessage?.key
        }])
    }
    else if (message.messageStubType) {
        const jid = message.key?.remoteJid
        //let actor = whatsappID (message.participant)
        let participants
        const emitParticipantsUpdate = (action) => (ev.emit('group-participants.update', {
            id: jid,
            author: message.key.participant,
            authorPn: message.key.participantAlt,
            participants,
            action
        }))
        const emitGroupUpdate = (update) => {
            ev.emit('groups.update', [{ id: jid, ...update, author: message.key.participant ?? undefined, authorPn: message.key.participantAlt }])
        }
        const emitGroupRequestJoin = (participant, action, method) => {
            ev.emit('group.join-request', {
                id: jid,
                author: message.key.participant,
                authorPn: message.key.participantAlt,
                participant: participant.lid,
                participantPn: participant.pn,
                action,
                method: method
            })
        }
        const participantsIncludesMe = () => participants.find(jid => WABinary_1.areJidsSameUser(meId, jid.phoneNumber))
        switch (message.messageStubType) {
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || []
                emitParticipantsUpdate('modify')
                break
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || []
                emitParticipantsUpdate('remove')
                // mark the chat read only if you left the group
                if (participantsIncludesMe()) {
                    chat.readOnly = true
                }
                break
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD:
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_INVITE:
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || []
                if (participantsIncludesMe()) {
                    chat.readOnly = false
                }
                emitParticipantsUpdate('add')
                break
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
            case Types_1.WAMessageStubType.COMMUNITY_PARTICIPANT_DEMOTE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || []
                emitParticipantsUpdate('demote')
                break
            case Types_1.WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
            case Types_1.WAMessageStubType.COMMUNITY_PARTICIPANT_PROMOTE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || []
                emitParticipantsUpdate('promote')
                break
            case Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                const announceValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
                break
            case Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT:
                const restrictValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
                break
            case Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT:
                const name = message.messageStubParameters?.[0]
                chat.name = name
                emitGroupUpdate({ subject: name })
                break
            case Types_1.WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
                const description = message.messageStubParameters?.[0]
                chat.description = description
                emitGroupUpdate({ desc: description })
                break
            case Types_1.WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
                const code = message.messageStubParameters?.[0]
                emitGroupUpdate({ inviteCode: code })
                break
            case Types_1.WAMessageStubType.GROUP_MEMBER_ADD_MODE:
                const memberAddValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
                break
            case Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
                const approvalMode = message.messageStubParameters?.[0]
                emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
                break
            case Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD:
                const participant = JSON.parse(message.messageStubParameters?.[0])
                const action = message.messageStubParameters?.[1]
                const method = message.messageStubParameters?.[2]
                emitGroupRequestJoin(participant, action, method)
                break
        }
    }
    else if (content?.pollUpdateMessage) {
    const pollUpdate = content.pollUpdateMessage;
    const creationMsgKey = {
        ...pollUpdate.pollCreationMessageKey, 
        remoteJidAlt: message?.key?.remoteJid 
    };
     
    const pollMsg = typeof getMessage === 'function' ? await getMessage(creationMsgKey) : undefined;
    
    if (pollMsg) {
        try {
  
            const voteMsg = decryptPollVoteMessage(pollMsg, message, creds.me);
            // دعم جميع إصدارات الـ Poll للاستخراج الصحيح للخيار
            const pollContent = pollMsg.message?.pollCreationMessage ||
                                pollMsg.message?.pollCreationMessageV2 ||
                                pollMsg.message?.pollCreationMessageV3 ||
                                pollMsg.message?.pollCreationMessageV5 ||
                                pollMsg.message?.pollCreationMessageV6;
                                
            const choices = pollContent?.options?.map(o => o.optionName) || [];
            const selected = voteMsg.selectedOptions.map(hash =>  choices.find(option => crypto_1.createHash(option, hash)))
            
            ev.emit('messages.update', [
                {
                    key: creationMsgKey,
                    update: {
                        status: 6,
                        pollUpdates: [
                            {
                                pollUpdateMessageKey: message.key,
                                vote: {
                                    selectedOptions: selected // إرسال النصوص الأصلية أو الـ Hashes الصحيحة حسب نظام البلاغ عندك
                                },
                                senderTimestampMs: generics_1.toNumber(pollUpdate.senderTimestampMs)
                            }
                        ]
                    }
                }
            ]);
        }
        catch (err) {
            console.log("ssrr")
            logger?.warn({ err: err.message, creationMsgKey }, 'failed to decrypt poll vote');
        }
    }
    else {
         console.log("opoo")
        logger?.warn(
            { creationMsgKey, hasGetMessage: typeof getMessage === 'function' },
            'poll creation message not found, cannot decrypt update'
        );
    }
}
    else if (content?.secretEncryptedMessage) {
        const encEventEdit = content.secretEncryptedMessage
        const creationMsgKey = encEventEdit.targetMessageKey

        if (WAProto_1.proto.Message.SecretEncryptedMessage.SecretEncType[encEventEdit.secretEncType] !== 'EVENT_EDIT') return

        // we need to fetch the event creation message to get the event enc key
        const eventMsg = await getMessage(creationMsgKey)
        if (eventMsg) {
            try {
                const meLidNormalised = WABinary_1.jidNormalizedUser(meLid)
                const eventCreatorJid = generics_1.getKeyAuthor(message.key, meLidNormalised)
                const responderJid = generics_1.getKeyAuthor(message.key, meLidNormalised)
                const eventEncKey = eventMsg.message?.messageContextInfo?.messageSecret || eventMsg.messageContextInfo?.messageSecret

                if (!eventEncKey) {
                    logger?.warn({ encEventEdit, creationMsgKey }, 'event edit: missing messageSecret for decryption')
                } else {
                    const responseMsg = decryptEventEdit(encEventEdit, {
                        eventEncKey,
                        eventCreatorJid,
                        eventMsgId: creationMsgKey.id,
                        responderJid
                    })
                    const content = messages_1.normalizeMessageContent(responseMsg)
                    const protocolMsg = content?.protocolMessage

                    ev.emit('messages.update', [
                        {
                            key: { ...message.key, id: protocolMsg.key?.id },
                            update: {
                                status: 7,
                                message: {
                                    messageContextInfo: responseMsg.messageContextInfo,
                                    editedMessage: {
                                        message: protocolMsg.editedMessage
                                    }
                                },
                                messageTimestamp: protocolMsg.timestampMs
                                    ? Math.floor(generics_1.toNumber(protocolMsg.timestampMs) / 1000)
                                    : message.messageTimestamp
                            }
                        }
                    ])
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey, encEventEdit }, 'failed to decrypt event edit')
            }
        }
        else {
            logger?.warn({ encEventEdit, creationMsgKey }, 'event creation message not found, cannot decrypt update')
        }
    }
    else if (content?.encEventResponseMessage) {
        const encEventResponse = content.encEventResponseMessage
        const creationMsgKey = encEventResponse.eventCreationMessageKey

        // we need to fetch the event creation message to get the event enc key
        const eventMsg = await getMessage(creationMsgKey)
        if (eventMsg) {
            try {
                const meLidNormalised = WABinary_1.jidNormalizedUser(meLid)
                const eventCreatorJid = generics_1.getKeyAuthor(creationMsgKey, meLidNormalised)
                const responderJid = generics_1.getKeyAuthor(message.key, meLidNormalised)
                const eventEncKey = eventMsg.messageContextInfo?.messageSecret

                if (!eventEncKey) {
                    logger?.warn({ encEventResponse, creationMsgKey }, 'event response: missing messageSecret for decryption')
                } else {
                    const responseMsg = decryptEventResponse(encEventResponse, {
                        eventEncKey,
                        eventCreatorJid,
                        eventMsgId: creationMsgKey.id,
                        responderJid
                    })

                    const eventResponse = {
                        eventResponseMessageKey: message.key,
                        senderTimestampMs: responseMsg.timestampMs,
                        response: responseMsg
                    }

                    ev.emit('messages.update', [
                        {
                            key: creationMsgKey,
                            update: {
                                status: 7,
                                eventResponses: [eventResponse]
                            }
                        }
                    ])
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey, encEventResponse }, 'failed to decrypt event response')
            }
        }
        else {
            logger?.warn({ encEventResponse, creationMsgKey }, 'event creation message not found, cannot decrypt update')
        }
    }
    else if (content?.encCommentMessage) {
        const encComment = content.encCommentMessage
        const creationMsgKey = encComment.targetMessageKey

        // we need to fetch the message to get the reaction enc key
        const commentMsg = await getMessage(creationMsgKey)
        if (commentMsg) {
            try {
                const meLidNormalised = WABinary_1.jidNormalizedUser(meLid)
                const commentCreatorJid = creationMsgKey.participant ? creationMsgKey.participant : message.key?.participant ? message.key.participant : meLidNormalised
                const commentJid = message.key?.participant ? message.key.participant : creationMsgKey.participant ? creationMsgKey.participant : meLidNormalised
                const commentEncKey = commentMsg.messageContextInfo?.messageSecret

                if (!commentEncKey) {
                    logger?.warn({ encComment, creationMsgKey }, 'comment message: missing messageSecret for decryption')
                } else {
                    const responseMsg = decryptComment(encComment, {
                        commentEncKey,
                        commentCreatorJid,
                        commentMsgId: creationMsgKey.id,
                        commentJid
                    })

                    ev.emit('messages.upsert', {
                        messages: [{
                            key: message.key,
                            message: responseMsg
                        }],
                        type: 'append'
                    })
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey, encComment }, 'failed to decrypt comment message')
            }
        }
        else {
            logger?.warn({ encComment, creationMsgKey }, 'creation message not found, cannot decrypt')
        }
    }
    else if (content?.encReactionMessage) {
        const encReaction = content.encReactionMessage
        const creationMsgKey = encReaction.targetMessageKey

        // we need to fetch the message to get the reaction enc key
        const reactMsg = await getMessage(creationMsgKey)
        if (reactMsg) {
            try {
                const meLidNormalised = WABinary_1.jidNormalizedUser(meLid)
                const reactionCreatorJid = creationMsgKey.participant ? creationMsgKey.participant : message.key?.participant ? message.key.participant : meLidNormalised
                const reactionJid = message.key?.participant ? message.key.participant : creationMsgKey.participant ? creationMsgKey.participant : meLidNormalised
                const reactionEncKey = reactMsg.messageContextInfo?.messageSecret

                if (!reactionEncKey) {
                    logger?.warn({ encReaction, creationMsgKey }, 'reaction: missing messageSecret for decryption')
                } else {
                    const responseMsg = decryptReaction(encReaction, {
                        reactionEncKey,
                        reactionCreatorJid,
                        reactionMsgId: creationMsgKey.id,
                        reactionJid
                    })

                    const Reaction = {
                        key: message.key,
                        message: {
                            reactionMessage: {
                                key: creationMsgKey,
                                text: responseMsg.text,
                                senderTimestampMs: responseMsg.senderTimestampMs
                            }
                        }
                    }

                    ev.emit('messages.upsert', {
                        messages: [Reaction],
                        type: 'append'
                    })
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey, encReaction }, 'failed to decrypt reaction')
            }
        }
        else {
            logger?.warn({ encReaction, creationMsgKey }, 'creation message not found, cannot decrypt')
        }
    }
    if (Object.keys(chat).length > 1) {
        ev.emit('chats.update', [chat])
    }
}

module.exports = {
    cleanMessage,
    isRealMessage,
    shouldIncrementChatUnread,
    getChatId,
    decryptPollVote,
    decryptPollVoteMessage,
    decryptEventEdit,
    decryptEventResponse,
    decryptComment,
    decryptReaction,
    processMessage
}
