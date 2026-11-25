"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Types_1 = require("../Types")
const Utils_1 = require("../Utils")
const make_mutex_1 = require("../Utils/make-mutex")
const WABinary_1 = require("../WABinary")
const WAUSync_1 = require("../WAUSync")
const socket_1 = require("./socket")
const { executeWMexQuery } = require("./mex")
const MAX_SYNC_ATTEMPTS = 2
const MESSAGE_URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/i

const decodeX = (jid) => {
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) {
        return jid
    }

    const decoded = WABinary_1.jidDecode(jid)
    return decoded
        ? WABinary_1.jidEncode(decoded.user, decoded.server)
        : jid
}

const isLid = (jid) => WABinary_1.isLidUser(jid)

const formatTimestamp = (timestamp) => {
    const seconds = Number(Utils_1.toNumber(timestamp))
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return null
    }

    return new Date(seconds * 1000).toLocaleString('fr-FR', {
        timeZone: 'Africa/Casablanca',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    })
}

const makeChatsSocket = (config) => {
    const { logger, markOnlineOnConnect, fireInitQueries, appStateMacVerification, shouldIgnoreJid, shouldSyncHistoryMessage, } = config
    const sock = socket_1.makeSocket(config)
    const { ev, ws, authState, generateMessageTag, sendNode, query, signalRepository, onUnexpectedError, groupFetchAllParticipating } = sock
    
    let privacySettings
    let syncState = Types_1.SyncState.Connecting
    
    /** this mutex ensures that the notifications (receipts, messages etc.) are processed in order */
    const processingMutex = make_mutex_1.makeMutex()

    const getJidPair = async (jid, chatJid) => {
        if (WABinary_1.isLidUser(jid)) {
            const pn = await signalRepository.lidMapping.getPNForLID(jid)
            if (pn) {
                return { jid: WABinary_1.jidNormalizedUser(pn), lid: WABinary_1.jidNormalizedUser(jid) }
            }
            const mappedPn = lidToJid(jid, chatJid)
            return mappedPn !== jid && WABinary_1.isJidUser(mappedPn)
                ? { jid: WABinary_1.jidNormalizedUser(mappedPn), lid: WABinary_1.jidNormalizedUser(jid) }
                : { jid, lid: undefined }
        }
        if (WABinary_1.isJidUser(jid)) {
            const lid = await signalRepository.lidMapping.getLIDForPN(jid)
            return { jid: WABinary_1.jidNormalizedUser(jid), lid: lid ? WABinary_1.jidNormalizedUser(lid) : undefined }
        }
        return { jid, lid: undefined }
    }

    const normalizeMessageKey = async key => {

        const remoteJidPair = await getJidPair(key.remoteJid, key.remoteJid)
        let participantPair = key.participant
            ? await getJidPair(key.participant, key.remoteJid)
            : { jid: undefined, lid: undefined }
        if (key.participant && key.participantAlt) {
            if (WABinary_1.isLidUser(key.participant) && WABinary_1.isJidUser(key.participantAlt)) {
                participantPair = {
                    jid: WABinary_1.jidNormalizedUser(key.participantAlt),
                    lid: WABinary_1.jidNormalizedUser(key.participant)
                }
            } else if (WABinary_1.isJidUser(key.participant) && WABinary_1.isLidUser(key.participantAlt)) {
                participantPair = {
                    jid: WABinary_1.jidNormalizedUser(key.participant),
                    lid: WABinary_1.jidNormalizedUser(key.participantAlt)
                }
            }
        }

        return {
            ...key,
            remoteJid: remoteJidPair.jid,
            remoteJidAlt: remoteJidPair.lid || (key.remoteJidAlt !== remoteJidPair.jid ? key.remoteJidAlt : undefined),
            ...(key.participant ? { participant: participantPair.jid } : {}),
            ...(key.participant
                ? { participantAlt: participantPair.lid || (key.participantAlt !== participantPair.jid ? key.participantAlt : undefined) }
                : {})
        }
    }

    const lidToJid = (jid, chatJid) => {
        const normalizedJid = decodeX(jid)
        if (!isLid(normalizedJid) || typeof config.LidToJid !== 'function') {
            return normalizedJid
        }

        const resolvedJid = config.LidToJid(normalizedJid, chatJid)
        if (resolvedJid && typeof resolvedJid.then === 'function') {
            throw new TypeError('LidToJid must be synchronous')
        }

        return typeof resolvedJid === 'string' && resolvedJid
            ? decodeX(resolvedJid)
            : normalizedJid
    }
    
    // Timeout for AwaitingInitialSync State
    let awaitingSyncTimeout
    
    const placeholderResendCache = config.placeholderResendCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })
    
    if (!config.placeholderResendCache) {
        config.placeholderResendCache = placeholderResendCache
    }
    
    /** helper function to fetch the given app state sync key */
    const getAppStateSyncKey = async (keyId) => {
        const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
        return key
    }
    
    const fetchPrivacySettings = async (force = false) => {
        if (!privacySettings || force) {
            const { content } = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'privacy',
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get'
                },
                content: [
                    { tag: 'privacy', attrs: {} }
                ]
            })
            privacySettings = WABinary_1.reduceBinaryNodeToDictionary(content?.[0], 'category')
        }
        return privacySettings
    }
    
    /** helper function to run a privacy IQ query */
    const privacyQuery = async (name, value) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'privacy',
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set'
            },
            content: [{
                    tag: 'privacy',
                    attrs: {},
                    content: [
                        {
                            tag: 'category',
                            attrs: { name, value }
                        }
                    ]
                }]
        })
    }
    
    const updateMessagesPrivacy = async (value) => {
        await privacyQuery('messages', value)
    }
    
    const updateCallPrivacy = async (value) => {
        await privacyQuery('calladd', value)
    }
    
    const updateLastSeenPrivacy = async (value) => {
        await privacyQuery('last', value)
    }
    
    const updateOnlinePrivacy = async (value) => {
        await privacyQuery('online', value)
    }
    
    const updateProfilePicturePrivacy = async (value) => {
        await privacyQuery('profile', value)
    }
    
    const updateStatusPrivacy = async (value) => {
        await privacyQuery('status', value)
    }
    const updateStatusText = async (text, emoji, exp) => {
        const input = {
            text: text === '' ? null : text ?? null,
            ephemeral_duration_sec: exp ?? 0
        };
        if (emoji) {
            input.emoji = { content: emoji };
        }
        return executeWMexQuery({ input }, 9152604461510864, "xwa2_update_text_status", query, generateMessageTag);
    };
    const updateReadReceiptsPrivacy = async (value) => {
        await privacyQuery('readreceipts', value)
    }
    
    const updateGroupsAddPrivacy = async (value) => {
        await privacyQuery('groupadd', value)
    }
    
    const updateDefaultDisappearingMode = async (duration) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'disappearing_mode',
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set'
            },
            content: [{
                    tag: 'disappearing_mode',
                    attrs: {
                        duration: duration.toString()
                    }
                }]
        })
    }
    
    const getBotListV2 = async () => {
	  const resp = await query({
    		tag: 'iq',
    		attrs: {
     			xmlns: 'bot',
     			to: WABinary_1.S_WHATSAPP_NET,
     			type: 'get'
    		},
    		content: [{
     			tag: 'bot',
     			attrs: {
      				v: '2'
     			}
    		}]
   	})
   
		const botNode = WABinary_1.getBinaryNodeChild(resp, 'bot')
		
		const botList = []
		
		for(const section of WABinary_1.getBinaryNodeChildren(botNode, 'section')) {
		  if(section.attrs.type === 'all') {
				for(const bot of WABinary_1.getBinaryNodeChildren(section, 'bot')) {
				  botList.push({
						jid: bot.attrs.jid,
						personaId: bot.attrs['persona_id']
					})
				}
			}
		}
		return botList
	}
	
	const getLidUser = async (jid) => {
        if (!jid) {
            throw new boom_1.Boom('Please input a jid user')
        }
        
        if (!WABinary_1.isJidUser(jid)) {
        	throw new boom_1.Boom('Invalid JID: Not a user JID!')
        }
        
        const targetJid = WABinary_1.jidNormalizedUser(jid)
        
        const usyncQuery = new WAUSync_1.USyncQuery() 
        usyncQuery.protocols.push({
        	name: 'lid', 
            getQueryElement: () => ({
            	tag: 'lid', 
                attrs: {}, 
                content: undefined
            }), 
            getUserElement: () => null, 
            parser: (node) => node.attrs.val
        }) 
        usyncQuery.users.push({
        	id: targetJid
        })
        
        const result = await sock.executeUSyncQuery(usyncQuery)
        
        if (result) {
            return result.list
        }
    }
    
    const fetchStatus = async (...jids) => {
        const usyncQuery = new WAUSync_1.USyncQuery().withStatusProtocol()
        for (const jid of jids) {
            usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid))
        }    
        const result = await sock.executeUSyncQuery(usyncQuery)
        if (result) {
            return result.list
        }
    }
    const fetchDisappearingDuration = async (...jids) => {   	
        const usyncQuery = new WAUSync_1.USyncQuery().withDisappearingModeProtocol()
        
        for (const jid of jids) {
            usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid))
        }
        
        const result = await sock.executeUSyncQuery(usyncQuery)
        if (result) {
            return result.list
        }
    }
    
    /** update the profile picture for yourself or a group */
    const updateProfilePicture = async (jid, content) => {
        let targetJid
        
        if (!jid) {
            throw new boom_1.Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        }
        
        if (WABinary_1.jidNormalizedUser(jid) !== WABinary_1.jidNormalizedUser(authState.creds.me.id)) {
            targetJid = WABinary_1.jidNormalizedUser(jid) // in case it is someone other than us
        }
        
        const { img } = await Utils_1.generateProfilePicture(content)
        
        await query({
            tag: 'iq',
            attrs: {
                target: targetJid,
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [
                {
                    tag: 'picture',
                    attrs: { type: 'image' },
                    content: img
                }
            ]
        })
    }

    /**
     * Update profile picture with panorama/wide image support.
     * Sends both a square preview (circle avatar) and a full-width image (banner).
     * @param {string} jid - Your JID or group JID
     * @param {WAMediaUpload} content - The image to use
     * @param {{maxWidth?: number, quality?: number}} [options] - Panorama options
     */
    const updatePanoramaProfilePicture = async (jid, content, options) => {
        let targetJid

        if (!jid) {
            throw new boom_1.Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        }

        if (WABinary_1.jidNormalizedUser(jid) !== WABinary_1.jidNormalizedUser(authState.creds.me.id)) {
            targetJid = WABinary_1.jidNormalizedUser(jid)
        }

        const { img, fullImg } = await Utils_1.generatePanoramaProfilePicture(content, options)

        // Send both the square preview and the full panorama image
        await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:profile:picture',
                ...(targetJid ? { target: targetJid } : {})
            },
            content: [
                {
                    tag: 'picture',
                    attrs: { type: 'image' },
                    content: img
                },
                {
                    tag: 'picture',
                    attrs: { type: 'fullsize' },
                    content: fullImg
                }
            ]
        })
    }
    
    /** remove the profile picture for yourself or a group */
    const removeProfilePicture = async (jid) => {
        let targetJid
        
        if (!jid) {
            throw new boom_1.Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        }
        
        if (WABinary_1.jidNormalizedUser(jid) !== WABinary_1.jidNormalizedUser(authState.creds.me.id)) {
            targetJid = WABinary_1.jidNormalizedUser(jid) // in case it is someone other than us
        }
        
        await query({
            tag: 'iq',
            attrs: {
                target: targetJid,
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:profile:picture'
            }
        })
    }
    
    /** update the profile status for yourself */
    const updateProfileStatus = async (status) => {
        await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'status'
            },
            content: [
                {
                    tag: 'status',
                    attrs: {},
                    content: Buffer.from(status, 'utf-8')
                }
            ]
        })
    }
    
    const updateProfileName = async (name) => {
        await chatModify({ pushNameSetting: name }, '')
    }
    
    const fetchBlocklist = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'get'
            }
        })
        
        const listNode = WABinary_1.getBinaryNodeChild(result, 'list')
        
        return WABinary_1.getBinaryNodeChildren(listNode, 'item').map((n) => n.attrs.jid)
    }
    
    const updateBlockStatus = async (jid, action) => {
        await query({
            tag: 'iq',
            attrs: {
                xmlns: 'blocklist',
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set'
            },
            content: [
                {
                    tag: 'item',
                    attrs: {
                        action,
                        jid
                    }
                }
            ]
        })
    }
    
    const getBusinessProfile = async (jid) => {
        const results = await query({
            tag: 'iq',
            attrs: {
                to: 's.whatsapp.net',
                xmlns: 'w:biz',
                type: 'get'
            },
            content: [{
                    tag: 'business_profile',
                    attrs: { v: '244' },
                    content: [{
                            tag: 'profile',
                            attrs: { jid }
                        }]
                }]
        })
        
        const profileNode = WABinary_1.getBinaryNodeChild(results, 'business_profile')
        
        const profiles = WABinary_1.getBinaryNodeChild(profileNode, 'profile')
        
        if (profiles) {
            const address = WABinary_1.getBinaryNodeChild(profiles, 'address')
            const description = WABinary_1.getBinaryNodeChild(profiles, 'description')
            const website = WABinary_1.getBinaryNodeChild(profiles, 'website')
            const email = WABinary_1.getBinaryNodeChild(profiles, 'email')
            const category = WABinary_1.getBinaryNodeChild(WABinary_1.getBinaryNodeChild(profiles, 'categories'), 'category')
            const businessHours = WABinary_1.getBinaryNodeChild(profiles, 'business_hours')
            const businessHoursConfig = businessHours
                ? WABinary_1.getBinaryNodeChildren(businessHours, 'business_hours_config')
                : undefined
            const websiteStr = website?.content?.toString()
            
            return {
                wid: profiles?.attrs?.jid,
                address: address?.content?.toString(),
                description: description?.content?.toString() || '',
                website: websiteStr ? [websiteStr] : [],
                email: email?.content?.toString(),
                category: category?.content?.toString(),
                'business_hours': {
                    timezone: businessHours?.attrs?.timezone,
                    'business_config': businessHoursConfig?.map(({ attrs }) => attrs)
                }
            }
        }
    }
    
    const cleanDirtyBits = async (type, fromTimestamp) => {
        logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
        await sendNode({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'urn:xmpp:whatsapp:dirty',
                id: generateMessageTag(),
            },
            content: [
                {
                    tag: 'clean',
                    attrs: {
                        type,
                        ...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null),
                    }
                }
            ]
        })
    }
    
    const newAppStateChunkHandler = (isInitialSync) => {
        return {
            onMutation(mutation) {
                Utils_1.processSyncAction(mutation, ev, authState.creds.me, isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined, logger)
            }
        }
    }
    
    const resyncAppState = ev.createBufferedFunction(async (collections, isInitialSync) => {
        // we use this to determine which events to fire
        // otherwise when we resync from scratch -- all notifications will fire
        const initialVersionMap = {}
        const globalMutationMap = {}
        await authState.keys.transaction(async () => {
            const collectionsToHandle = new Set(collections)
            // in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
            const attemptsMap = {}
            // keep executing till all collections are done
            // sometimes a single patch request will not return all the patches (God knows why)
            // so we fetch till they're all done (this is determined by the "has_more_patches" flag)
            while (collectionsToHandle.size) {
                const states = {}
                const nodes = []
                
                for (const name of collectionsToHandle) {
                    const result = await authState.keys.get('app-state-sync-version', [name])
                    let state = result[name]
                    if (state) {
                        if (typeof initialVersionMap[name] === 'undefined') {
                            initialVersionMap[name] = state.version
                        }
                    }
                    else {
                        state = Utils_1.newLTHashState()
                    }
                    states[name] = state
                    logger.info(`resyncing ${name} from v${state.version}`)
                    nodes.push({
                        tag: 'collection',
                        attrs: {
                            name,
                            version: state.version.toString(),
                            // return snapshot if being synced from scratch
                            'return_snapshot': (!state.version).toString()
                        }
                    })
                }
                
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        to: WABinary_1.S_WHATSAPP_NET,
                        xmlns: 'w:sync:app:state',
                        type: 'set'
                    },
                    content: [
                        {
                            tag: 'sync',
                            attrs: {},
                            content: nodes
                        }
                    ]
                })
                
                // extract from binary node
                const decoded = await Utils_1.extractSyncdPatches(result, config?.options)
                
                for (const key in decoded) {
                    const name = key
                    const { patches, hasMorePatches, snapshot } = decoded[name]
                    try {
                        if (snapshot) {
                            const { state: newState, mutationMap } = await Utils_1.decodeSyncdSnapshot(name, snapshot, getAppStateSyncKey, initialVersionMap[name], appStateMacVerification.snapshot)
                            states[name] = newState
                            Object.assign(globalMutationMap, mutationMap)
                            logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
                        }
                        
                        // only process if there are syncd patches
                        if (patches.length) {
                            const { state: newState, mutationMap } = await Utils_1.decodePatches(name, patches, states[name], getAppStateSyncKey, config.options, initialVersionMap[name], logger, appStateMacVerification.patch)
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
                            logger.info(`synced ${name} to v${newState.version}`)
                            initialVersionMap[name] = newState.version
                            Object.assign(globalMutationMap, mutationMap)
                        }
                        
                        if (hasMorePatches) {
                            logger.info(`${name} has more patches...`)
                        }                        
                        else { // collection is done with sync
                            collectionsToHandle.delete(name)
                        }
                    }                     
                    catch (error) {
                        // if retry attempts overshoot
                        // or key not found
                        const isIrrecoverableError = attemptsMap[name] >= MAX_SYNC_ATTEMPTS
                            || error.output?.statusCode === 404
                            || error.name === 'TypeError'
                        logger.info({ name, error: error.stack }, `failed to sync state from version${isIrrecoverableError ? '' : ', removing and trying from scratch'}`)
                        await authState.keys.set({ 'app-state-sync-version': { [name]: null } })
                        // increment number of retries
                        attemptsMap[name] = (attemptsMap[name] || 0) + 1
                        
                        if (isIrrecoverableError) {
                            // stop retrying
                            collectionsToHandle.delete(name)
                        }
                    }
                }
            }
        }, authState?.creds?.me?.id || 'resync-app-state')
        
        const { onMutation } = newAppStateChunkHandler(isInitialSync)
        
        for (const key in globalMutationMap) {
            onMutation(globalMutationMap[key])
        }
    })    
    
    // source: https://github.com/WhiskeySockets/Baileys/pull/1677
    const createCallLink = async (type, event, timeoutMs) => {
    	type = type?.toLowerCase() 
    
    	if (!type || (type !== 'audio' && type !== 'video')) {
    		throw new Error('Make sure the type is audio or video!') 
    	}
    
    	const result = await query({
    		tag: 'call',
    		attrs: {
    			id: generateMessageTag(), 
    			to: '@call'
    		}, 
    		content: [{
    			tag: 'link_create', 
    			attrs: {
    				media: type
    			}, 
    			content: event ? [{ 
    				tag: 'event', 
    				attrs: {
    					start_time: String(event) 
    				}
    			}] : undefined
    		}]
    	}, timeoutMs) 
    
    	const child = WABinary_1.getBinaryNodeChild(result, 'link_create') 
    	const token = child?.attrs?.token
    
    	return type === 'audio' ? Defaults_1.CALL_AUDIO_PREFIX + token : Defaults_1.CALL_VIDEO_PREFIX + token
    }
    
    const sendPresenceUpdate = async (type, toJid, options = {}) => {
        const me = authState.creds.me
        
        if (type === 'available' || type === 'unavailable') {
            if (!me.name) {
                logger.warn('no name present, ignoring presence update request...')
                return
            }
            
            ev.emit('connection.update', { isOnline: type === 'available' })
            await sendNode({
                tag: 'presence',
                attrs: {
                    name: me.name.replace(/@/g, ''),
                    type
                }
            })
        }
        else {
        	const { server } = WABinary_1.jidDecode(toJid) 
        
            await sendNode({
                tag: 'chatstate',
                attrs: {
                    from: server === 'lid' ? me.lid : me.id,
                    to: toJid
                },
                content: [
                    {
                        tag: type === 'recording' ? 'composing' : type,
                        attrs: type === 'recording' ? { media: 'audio' } : {}
                    }
                ]
            })
            
            const { simulateTyping = false, typingDuration = 1500 } = options
            
            if (simulateTyping && (type === 'composing' || type === 'recording')) {
                await new Promise(r => setTimeout(r, typingDuration))
                await sendNode({
                    tag: 'chatstate',
                    attrs: {
                        from: server === 'lid' ? me.lid : me.id,
                        to: toJid
                    },
                    content: [
                        {
                            tag: 'paused',
                            attrs: {}
                        }
                    ]
                }).catch(() => {})
            }
        }
    }
    
    /**
     * @param toJid the jid to subscribe to
     * @param tcToken token for subscription, use if present
     */
    const presenceSubscribe = (toJid, tcToken) => (sendNode({
        tag: 'presence',
        attrs: {
            to: toJid,
            id: generateMessageTag(),
            type: 'subscribe'
        },
        content: tcToken
            ? [
                {
                    tag: 'tctoken',
                    attrs: {},
                    content: tcToken
                }
            ]
            : undefined
    }))
    
    const handlePresenceUpdate = async ({ tag, attrs, content }) => {
        let presence
        const originalJid = attrs.from
        const originalParticipant = attrs.participant || attrs.from
        
        if (shouldIgnoreJid(originalJid) && originalJid !== '@s.whatsapp.net') {
            return
        }
        
        if (tag === 'presence') {
            presence = {
                lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
                lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
            }
        }
        
        else if (Array.isArray(content)) {
            const [firstChild] = content
            let type = firstChild.tag
            
            if (type === 'paused') {
                type = 'available'
            }
            
            if (firstChild.attrs?.media === 'audio') {
                type = 'recording'
            }
            
            presence = { lastKnownPresence: type }
        }
        
        else {
            logger.error({ tag, attrs, content }, 'recv invalid presence node')
        }
        
        if (presence) {
            const jidPair = await getJidPair(originalJid, originalJid)
            const participantPair = await getJidPair(originalParticipant, originalJid)
            const presenceUpdate = {
                id: jidPair.jid,
                ...(jidPair.lid ? { lid: jidPair.lid } : {}),
                presences: {
                    [participantPair.jid]: {
                        ...presence,
                        ...(participantPair.lid ? { lid: participantPair.lid } : {})
                    }
                }
            }
            ev.emit('presence.update', presenceUpdate)
        }
    }
    
    const appPatch = async (patchCreate) => {
        const name = patchCreate.type
        const myAppStateKeyId = authState.creds.myAppStateKeyId
        
        if (!myAppStateKeyId) {
            throw new boom_1.Boom('App state key not present!', { statusCode: 400 })
        }
        
        let initial
        let encodeResult
        
        await processingMutex.mutex(async () => {
            await authState.keys.transaction(async () => {
                logger.debug({ patch: patchCreate }, 'applying app patch')
                await resyncAppState([name], false)
                const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
                initial = currentSyncVersion || Utils_1.newLTHashState()
                encodeResult = await Utils_1.encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
                const { patch, state } = encodeResult
                
                const node = {
                    tag: 'iq',
                    attrs: {
                        to: WABinary_1.S_WHATSAPP_NET,
                        type: 'set',
                        xmlns: 'w:sync:app:state'
                    },
                    content: [
                        {
                            tag: 'sync',
                            attrs: {},
                            content: [
                                {
                                    tag: 'collection',
                                    attrs: {
                                        name,
                                        version: (state.version - 1).toString(),
                                        'return_snapshot': 'false'
                                    },
                                    content: [
                                        {
                                            tag: 'patch',
                                            attrs: {},
                                            content: WAProto_1.proto.SyncdPatch.encode(patch).finish()
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
                await query(node)
                await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
            }, authState?.creds?.me?.id || 'app-patch')
        })
        
        if (config.emitOwnEvents) {
            const { onMutation } = newAppStateChunkHandler(false)
            const { mutationMap } = await Utils_1.decodePatches(name, [{ ...encodeResult.patch, version: { version: encodeResult.state.version }, }], initial, getAppStateSyncKey, config.options, undefined, logger)
            
            for (const key in mutationMap) {
                onMutation(mutationMap[key])
            }
        }
    }
    
    /** sending non-abt props may fix QR scan fail if server expects */
    const fetchProps = async () => {
        const resultNode = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                xmlns: 'w',
                type: 'get',
            },
            content: [
                { tag: 'props', attrs: {
                        protocol: '2',
                        hash: authState?.creds?.lastPropHash || ''
                    } }
            ]
        })
        
        const propsNode = WABinary_1.getBinaryNodeChild(resultNode, 'props')
        let props = {}
        
        if (propsNode) {
            if (propsNode.attrs?.hash) { // on some clients, the hash is returning as undefined
                authState.creds.lastPropHash = propsNode?.attrs?.hash
                ev.emit('creds.update', authState.creds)
            }
            
            props = WABinary_1.reduceBinaryNodeToDictionary(propsNode, 'prop')
        }
        logger.debug('fetched props')
        return props
    }
    const updateTextStatus = async (text, emoji, exp) => {
        const input = {
            text: text === '' ? null : text ?? null,
            ephemeral_duration_sec: exp ?? 0
        };
        if (emoji) {
            input.emoji = { content: emoji };
        }
        return executeWMexQuery({ input }, Types_1.QueryIds.UPDATE_TEXT_STATUS, Types_1.XWAPaths.xwa2_update_text_status, query, generateMessageTag);
    };
    const fetchTextStatus = async (jids) => {
        const list = (Array.isArray(jids) ? jids : [jids]).map(jid => ({ jid: WABinary_1.jidNormalizedUser(jid) }));
        return executeWMexQuery({ input: list }, Types_1.QueryIds.TEXT_STATUS_LIST, Types_1.XWAPaths.xwa2_text_status_list, query, generateMessageTag);
    };

    const fetchAbout = async (jid) => {
        const { user } = WABinary_1.jidDecode(WABinary_1.jidNormalizedUser(jid)) || {};
        if (!user) {
            throw new boom_1.Boom('Invalid user jid', { statusCode: 400 });
        }
        const response = await executeWMexQuery({ user: { user_id: user } }, Types_1.QueryIds.ABOUT_STATUS, Types_1.XWAPaths.xwa2_users_updates_since, query, generateMessageTag);
        const updates = Array.isArray(response) ? response[0]?.updates : undefined;
        return {
            jid: WABinary_1.jidNormalizedUser(jid),
            status: updates?.[0]?.text ?? null,
            response
        };
    };
    /**
     * modify a chat -- mark unread, read etc.
     * lastMessages must be sorted in reverse chronologically
     * requires the last messages till the last message received required for archive & unread
    */
    const chatModify = (mod, jid) => {
        const patch = Utils_1.chatModificationToAppPatch(mod, jid)
        return appPatch(patch)
    }
    
    /**
     * Enable/Disable link preview privacy, not related to baileys link preview generation
     */
    const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled) => {
    	return chatModify({
    		disableLinkPreviews: {
    			isPreviewsDisabled
    		}
    	}, '') 
    } 
    
    /**
     * Star or Unstar a message
     */
    const star = (jid, messages, star) => {
        return chatModify({
            star: {
                messages,
                star
            }
        }, jid)
    }
    
    /**
     * Add Or Edit Contact
     */
    const addOrEditContact = (jid, contact) => {
    	return chatModify({
    	    contact
        }, jid) 
    }
    
    /**
     * Remove Contact
     */
     const removeContact = (jid) => {
     	return chatModify({
     	    contact: null
         }, jid) 
     }
    
    /**
     * Adds label
     */
    const addLabel = (jid, labels) => {
        return chatModify({
            addLabel: {
                ...labels
            }
        }, jid)
    }
    
    /**
     * Adds label for the chats
     */
    const addChatLabel = (jid, labelId) => {
        return chatModify({
            addChatLabel: {
                labelId
            }
        }, jid)
    }
    
    /**
     * Removes label for the chat
     */
    const removeChatLabel = (jid, labelId) => {
        return chatModify({
            removeChatLabel: {
                labelId
            }
        }, jid)
    }
    
    /**
     * Adds label for the message
     */
    const addMessageLabel = (jid, messageId, labelId) => {
        return chatModify({
            addMessageLabel: {
                messageId,
                labelId
            }
        }, jid)
    }
    
    /**
     * Removes label for the message
     */
    const removeMessageLabel = (jid, messageId, labelId) => {
        return chatModify({
            removeMessageLabel: {
                messageId,
                labelId
            }
        }, jid)
    }
    
    /**
     * Removes Chats 
     */
     const clearMessage = (jid, key, timeStamp) => {
         return chatModify({
           delete: true,
           lastMessages: [{
                key: key,
                messageTimestamp: timeStamp
            }],
        }, jid)
     }
     
     /**
     * Add or Edit Quick Reply
     */
    const addOrEditQuickReply = (quickReply) => {
        return chatModify({
            quickReply
        }, '')
    }
    
    /**
     * Remove Quick Reply
     */
    const removeQuickReply = (timestamp) => {
        return chatModify({
            quickReply: { timestamp, deleted: true }
        }, '')
    }
     
    /**
     * queries need to be fired on connection open
     * help ensure parity with WA Web
     * */
    const executeInitQueries = async () => {
        await Promise.all([
            fetchProps(),
            fetchBlocklist(),
            fetchPrivacySettings(),
        ])
    }

    const serializeMessage = (message) => {
        message = { ...message }
        const key = message.key
        key.deviceId ??= 0
        const originalChat = key.remoteJid
        const originalParticipant = key.participant
        const senderLid = message.fromMe
            ? authState.creds.me?.lid
            : [
                key.participantAlt,
                originalParticipant,
                message.attrs?.from,
                key.remoteJidAlt,
                originalChat
            ].find(isLid)
        let chat = lidToJid(originalChat, originalChat)
        if (isLid(chat) && WABinary_1.isJidUser(message.attrs?.sender_pn)) {
            chat = decodeX(message.attrs.sender_pn)
        }
        if (isLid(originalChat) && !isLid(chat)) {
            key.remoteJidAlt = decodeX(originalChat)
        }
        key.remoteJid = chat
        if (originalParticipant) {
            key.participant = lidToJid(originalParticipant, chat)
            if (isLid(originalParticipant) && !isLid(key.participant)) {
                key.participantAlt = decodeX(originalParticipant)
            }
        }
        const originalSender = originalParticipant || originalChat
        const senderJid = originalSender === originalChat && isLid(originalSender) && !isLid(chat)
            ? chat
            : originalSender
        if (message.statusMentionMessageInfo?.quotedStatus) {
            message.message = message.statusMentionMessageInfo.quotedStatus
        }
        const content = Utils_1.extractMessageContent(message.message)
        const messageType = Utils_1.getContentType(content)
        const messageContent = messageType === 'conversation' ? content?.conversation : content?.[messageType]
        const statusMentionedStory = !!message.statusMentionMessageInfo?.quotedStatus
        const groupStatusMessage = !!message.message?.groupStatusMentionMessage
        const messageTypes = {
            conversation: 'text',
            extendedTextMessage: 'text',
            imageMessage: 'image',
            videoMessage: 'video',
            documentMessage: 'document',
            stickerMessage: 'sticker',
            reactionMessage: 'reaction',
            contactMessage: 'contact',
            contactsArrayMessage: 'contact',
            locationMessage: 'location',
            liveLocationMessage: 'location',
            productMessage: 'product',
            pollCreationMessage: 'poll',
            pollCreationMessageV2: 'quiz',
            pollCreationMessageV3: 'poll',
            pollCreationMessageV4: 'poll',
            pollCreationMessageV5: 'poll',
            pollCreationMessageV6: 'poll',
            pollUpdateMessage: 'pollUpdate',
            eventMessage: 'event',
            groupInviteMessage: 'groupInvite',
            groupStatusMentionMessage: 'groupStatus',
            albumMessage: 'album'
        }

        message.id = key.id
        message.chat = chat
        message.isGroup = WABinary_1.isJidGroup(chat)
        message.fromMe = Boolean(key.fromMe)
        message.sender = WABinary_1.jidNormalizedUser(lidToJid(
            message.fromMe
                ? authState.creds.me?.id
                : senderJid,
            chat
        ))
        message.senderLid = isLid(senderLid) ? decodeX(senderLid) : undefined
        message.mtype = messageType
        message.type = WABinary_1.isJidStatusBroadcast(chat)
            ? 'story'
            : WABinary_1.isJidNewsletter(chat)
                ? 'news'
                : message.fromMe && message.id?.endsWith('ME2')
                    ? 'baileys'
                    : statusMentionedStory
                        ? 'groupStory'
                        : groupStatusMessage
                            ? 'groupStatus'
                            : messageType === 'audioMessage'
                                ? (messageContent?.ptt ? 'vocale' : 'audio')
                                : messageTypes[messageType] || messageType
        message.text = typeof messageContent === 'string'
            ? messageContent
            : messageContent?.text ||
                messageContent?.caption ||
                messageContent?.selectedDisplayText ||
                messageContent?.selectedId ||
                messageContent?.contentText ||
                messageContent?.singleSelectReply?.selectedRowId ||
                messageContent?.selectedButtonId ||
                messageContent?.name ||
                messageContent?.title ||
                messageContent?.reactionMessage?.text ||
                content?.conversation ||
                ''
        const nativeFlowParams = messageContent?.nativeFlowResponseMessage?.paramsJson
        if (nativeFlowParams) {
            try {
                const params = JSON.parse(nativeFlowParams)
                if (typeof params.id === 'string') {
                    message.text = params.id
                }
            } catch (error) {
                logger.warn({ error, messageId: key.id }, 'invalid native flow response params')
            }
        }
        message.reaction = content?.reactionMessage?.text || undefined
        message.isReaction = !!content?.reactionMessage
        message.mentions = (messageContent?.contextInfo?.mentionedJid || [])
            .map(jid => lidToJid(jid, chat))
        message.expiration = messageContent?.contextInfo?.expiration || 0
        message.viewonce = Boolean(
            message.viewonce ||
            messageContent?.viewOnce ||
            content?.viewOnce ||
            message.message?.viewOnceMessage ||
            message.message?.viewOnceMessageV2 ||
            message.message?.viewOnceMessageV2Extension
        )
        message.broadcast = Boolean(
            message.broadcast ||
            WABinary_1.isJidBroadcast(chat) ||
            WABinary_1.isJidStatusBroadcast(chat) ||
            statusMentionedStory
        )
        message.newsletter = Boolean(message.newsletter || WABinary_1.isJidNewsletter(chat))
        message.baileys = Boolean(message.fromMe && message.id?.endsWith('ME2'))
        message.date = formatTimestamp(message.messageTimestamp)
        message.nme = message.pushName || message.verifiedBizName || message.attrs?.notify || undefined
        message.name = message.nme
        message.lien = messageContent?.matchedText ||
            messageContent?.canonicalUrl ||
            MESSAGE_URL_REGEX.test(message.text) ||
            false
        message.device = Utils_1.getDevice(message.id)

        const quotedMessage = messageContent?.contextInfo?.quotedMessage
        if (quotedMessage) {
            const normalizedQuotedMessage = Utils_1.normalizeMessageContent(quotedMessage) || quotedMessage
            const quotedContent = Utils_1.extractMessageContent(normalizedQuotedMessage)
            const quotedType = Utils_1.getContentType(quotedContent)
            const quotedValue = quotedType === 'conversation'
                ? quotedContent?.conversation
                : quotedContent?.[quotedType]
            const quotedContext = messageContent.contextInfo
            const quotedChat = lidToJid(quotedContext.remoteJid || chat, chat)
            const rawQuotedSender = quotedContext.participant || quotedChat
            const quotedSender = WABinary_1.jidNormalizedUser(lidToJid(rawQuotedSender, quotedChat))
            const quotedId = quotedContext.stanzaId
            const quotedFromMe = WABinary_1.areJidsSameUser(quotedSender, authState.creds.me?.id)
            const quotedSenderLid = isLid(rawQuotedSender)
                ? decodeX(rawQuotedSender)
                : undefined
            const quotedFriendlyType = quotedType === 'audioMessage'
                ? (quotedValue?.ptt ? 'vocale' : 'audio')
                : messageTypes[quotedType] || quotedType
            const quotedKey = {
                remoteJid: quotedChat,
                fromMe: quotedFromMe,
                ...(quotedId ? { id: quotedId } : {}),
                ...(message.isGroup ? { participant: quotedSender } : {})
            }
            const fakeObj = WAProto_1.proto.WebMessageInfo.fromObject({
                key: quotedKey,
                message: normalizedQuotedMessage
            })
            const quotedMediaMessage = !!(
                quotedValue?.url ||
                quotedValue?.directPath ||
                /image|video|audio|document|sticker/i.test(quotedType || '')
            )

            message.quoted = {
                ...normalizedQuotedMessage,
                id: quotedId,
                chat: quotedChat,
                sender: quotedSender,
                senderLid: quotedSenderLid,
                fromMe: quotedFromMe,
                mtype: quotedType,
                type: quotedFriendlyType,
                mimetype: quotedValue?.mimetype,
                mediaMessage: quotedMediaMessage,
                isBaileys: !!quotedId && (quotedId.startsWith('MDS') || quotedId.length === 16),
                viewonce: Boolean(
                    quotedValue?.viewOnce ||
                    normalizedQuotedMessage?.viewOnce ||
                    normalizedQuotedMessage?.viewOnceMessage ||
                    normalizedQuotedMessage?.viewOnceMessageV2
                ),
                text: typeof quotedValue === 'string'
                    ? quotedValue
                    : quotedValue?.text ||
                        quotedValue?.caption ||
                        quotedValue?.contentText ||
                        quotedValue?.selectedDisplayText ||
                        quotedValue?.selectedId ||
                        quotedValue?.singleSelectReply?.selectedRowId ||
                        '',
                fakeObj,
                key: fakeObj.key
            }
            message.quoted.react = (emoji) =>
                sendMessage(chat, { react: { text: emoji, key: fakeObj.key } })
            message.quoted.delete = () =>
                sendMessage(chat, { delete: fakeObj.key })
            if (quotedMediaMessage) {
                message.quoted.download = (type = 'buffer', options = {}) =>
                    Utils_1.downloadMediaMessage(fakeObj, type, options)
            }
        }
        message.target = !message.message
            ? null
            : content?.reactionMessage
                ? lidToJid(content.reactionMessage.key?.participant, chat) || null
                : message.quoted?.sender || message.mentions[0] || null

        const sendMessage = (...args) => {
            const messageSocket = config.messageSocket
            if (typeof messageSocket?.sendMessage !== 'function') {
                throw new Error('Message helpers are not available before the socket is initialized')
            }
            return messageSocket.sendMessage(...args)
        }

        message.reply = (text, options = {}) =>
            sendMessage(chat, { text }, {
                ...options,
                ephemeralExpiration: options.ephemeralExpiration ?? message.expiration,
                quoted: message
            })
        message.react = (emoji) =>
            sendMessage(chat, { react: { text: emoji, key } })
        message.delete = () =>
            sendMessage(chat, { delete: key })
        message.download = (type = 'buffer', options = {}) =>
            Utils_1.downloadMediaMessage(message, type, options)

        delete message.attrs
        return message
    }
    
    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {
        if (msg.key.deviceId === undefined && msg.attrs) {
            const senderJid = WABinary_1.isJidGroup(msg.attrs.from) || WABinary_1.isJidBroadcast(msg.attrs.from)
                ? msg.attrs.participant
                : msg.attrs.from
            const deviceId = WABinary_1.jidDecode(senderJid)?.device
            if (deviceId !== undefined) {
                msg.key.deviceId = deviceId
            }
        }
        msg = {
            ...msg,
            key: await normalizeMessageKey(msg.key)
        }
        const serializedMessage = serializeMessage(msg)
        ev.emit('messages.upsert', { messages: [serializedMessage], type })
        if (!!msg.pushName) {
            let jid = msg.key.fromMe ? authState.creds.me.id : (msg.key.participant || msg.key.remoteJid)
            jid = WABinary_1.jidNormalizedUser(jid)
            const contactLid = msg.key.fromMe
                ? authState.creds.me?.lid
                : WABinary_1.isJidGroup(msg.key.remoteJid)
                    ? msg.key.participantAlt
                    : msg.key.remoteJidAlt
            
            if (!msg.key.fromMe) {
                ev.emit('contacts.update', [{
                    id: jid,
                    ...(isLid(contactLid) ? { lid: decodeX(contactLid) } : {}),
                    notify: msg.pushName,
                    verifiedName: msg.verifiedBizName
                }])
            }
            
            // update our pushname too
            if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
                ev.emit('creds.update', { me: { ...authState.creds.me, name: msg.pushName } })
            }
        }
        
        const historyMsg = Utils_1.getHistoryMsg(msg.message)
        const shouldProcessHistoryMsg = historyMsg
            ? (shouldSyncHistoryMessage(historyMsg)
                && Defaults_1.PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType))
            : false
            
        if (historyMsg && syncState === Types_1.SyncState.AwaitingInitialSync) {
            if (awaitingSyncTimeout) {
            	clearTimeout(awaitingSyncTimeout) 
            	awaitingSyncTimeout = undefined
            }
            
            if (shouldProcessHistoryMsg) {
            	syncState = Types_1.SyncState.Syncing
            	logger.info('Transitioned to Syncing state') 
            	// Let doAppStateSync handle the final flush after it`s done
            } else {
            	syncState = Types_1.SyncState.Online
            	logger.info('History sync skipped, transitioning to Online state and flushing buffer') 
            	ev.flush() 
            }
        }
        
        const doAppStateSync = async () => {
        	if (syncState === Types_1.SyncState.Syncing) {
        		logger.info('Doing app state sync') 
        		await resyncAppState(Types_1.ALL_WA_PATCH_NAMES, true)
        
        		// Sync is complete, go online and flush everything
        		syncState = Types_1.SyncState.Online
        		logger.info('App state sync complete, transitioning to Online state and flushing buffer') 
        		ev.flush() 
        
        		const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
        		ev.emit('creds.update', { accountSyncCounter }) 
        	}
        }
        
        await Promise.all([
            (async () => {
                if (shouldProcessHistoryMsg) {
                    await doAppStateSync()
                }
            })(),
            Utils_1.processMessage(msg, {
            	signalRepository, 
                shouldProcessHistoryMsg,
                placeholderResendCache,
                ev,
                creds: authState.creds,
                keyStore: authState.keys,
                logger,
                options: config.options,
                getMessage: config.getMessage,
            })
        ])
        
        if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === Types_1.SyncState.Syncing) {
        	logger.info('App state sync key arrived, triggering app state sync') 
        	await doAppStateSync() 
        }
    })
    
    ws.on('CB:presence', node =>
        handlePresenceUpdate(node).catch(error => onUnexpectedError(error, 'presence update'))
    )
    ws.on('CB:chatstate', node =>
        handlePresenceUpdate(node).catch(error => onUnexpectedError(error, 'chat state update'))
    )
    ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = WABinary_1.getBinaryNodeChild(node, 'dirty')
        const type = attrs.type
        
        switch (type) {
            case 'account_sync':
                if (attrs.timestamp) {
                    let { lastAccountSyncTimestamp } = authState.creds
                    if (lastAccountSyncTimestamp) {
                        await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
                    }
                    lastAccountSyncTimestamp = +attrs.timestamp
                    ev.emit('creds.update', { lastAccountSyncTimestamp })
                }
                break
            case 'groups':
                await groupFetchAllParticipating()
                await cleanDirtyBits('groups')
                break
            default:
                logger.info({ node }, 'received unknown sync')
                break
        }
    })
    
    ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
        if (connection === 'open') {
            if (fireInitQueries) {
                executeInitQueries()
                    .catch(error => onUnexpectedError(error, 'init queries'))
            }
            sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable')
                .catch(error => onUnexpectedError(error, 'presence update requests'))
        }
        
        if (!receivedPendingNotifications || syncState !== Types_1.SyncState.Connecting) {
        	return
        }
        
        syncState = Types_1.AwaitingInitialSync
        logger.info('Connection is now AwaitingInitialSync, buffering events') 
        ev.buffer() 
        
        const willSyncHistory = shouldSyncHistoryMessage(WAProto_1.proto.Message.HistorySyncNotification.fromObject({
        	syncType: WAProto_1.proto.HistorySync.HistorySyncType.RECENT
        })) 
        
        if (!willSyncHistory) {
        	logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.') 
        	syncState = Types_1.SyncState.Online
        	setTimeout(() => ev.flush(), 0) 
        	return 
        }
        
        logger.info('History sync is enabled, awaiting notification with a 20s timeout.') 
        
        if (awaitingSyncTimeout) {
        	clearTimeout(awaitingSyncTimeout) 
        }
        
        awaitingSyncTimeout = setTimeout(() => {
        	if (syncState === Types_1.SyncState.AwaitingInitialSync) {
        		logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer') 
        		syncState = Types_1.SyncState.Online
        		ev.flush() 
        	}
        }, 20_000) 
    })
    
    return {
        ...sock, 
        star, 
        addOrEditContact, 
        removeContact, 
        processingMutex,
        fetchPrivacySettings,
        upsertMessage,
        appPatch,
        createCallLink, 
        sendPresenceUpdate,
        presenceSubscribe, 
        getBotListV2,  
        getLidUser, 
        fetchBlocklist,
        fetchStatus,
        updateStatusText,
        fetchDisappearingDuration,
        updateProfilePicture,
        updatePanoramaProfilePicture,
        removeProfilePicture,
        updateProfileStatus,
        updateProfileName,
        updateBlockStatus,
        updateCallPrivacy,
        updateMessagesPrivacy, 
        updateLastSeenPrivacy,
        updateOnlinePrivacy,
        updateProfilePicturePrivacy,
        updateStatusPrivacy,
        updateReadReceiptsPrivacy,
        updateGroupsAddPrivacy,
        updateDefaultDisappearingMode,
        updateDisableLinkPreviewsPrivacy, 
        getBusinessProfile,
        resyncAppState,
        chatModify,
        cleanDirtyBits,
        addLabel,
        addChatLabel,
        removeChatLabel,
        addMessageLabel,
        removeMessageLabel,
        clearMessage, 
        addOrEditQuickReply,
        removeQuickReply,
       fetchAbout, fetchTextStatus, updateTextStatus
    }
}

module.exports = {
  makeChatsSocket
}