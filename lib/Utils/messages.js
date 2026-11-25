"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const boom_1 = require("@hapi/boom")
const axios_1 = __importDefault(require("axios"))
const crypto_1 = require("crypto")
const fs_1 = require("fs")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const crypto_2 = require("./crypto")
const generics_1 = require("./generics")
const messages_media_1 = require("./messages-media")
const message_composer_1 = require("./message-composer")
const rich_message_utils_1 = require("./rich-message-utils")

const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
}

const MessageTypeProto = {
    'image': Types_1.WAProto.Message.ImageMessage,
    'video': Types_1.WAProto.Message.VideoMessage,
    'audio': Types_1.WAProto.Message.AudioMessage,
    'sticker': Types_1.WAProto.Message.StickerMessage,
    'document': Types_1.WAProto.Message.DocumentMessage,
}

const MESSAGE_PROTO_KEYS = new Set(
    Object.keys(WAProto_1.proto.Message.prototype).filter(
        key => !key.startsWith('_') && typeof WAProto_1.proto.Message.prototype[key] !== 'function'
    )
)

const RAW_MODE_HELPER_KEYS = new Set([
    'raw', 'text', 'linkPreview', 'mentions', 'mentionAll', 'contextInfo', 'buttons', 'templateButtons',
    'interactiveButtons', 'nativeFlow', 'optionText', 'optionTitle', 'offerText', 'offerCode', 'offerUrl',
    'offerExpiration', 'title', 'subtitle', 'footer', 'hasMediaAttachment', 'sections', 'buttonText', 'listType',
    'cards', 'contacts', 'location', 'react', 'delete', 'forward', 'force', 'disappearingMessagesInChat',
    'groupInvite', 'adminInvite', 'pin', 'keep', 'call', 'event', 'payment', 'paymentInvite', 'poll', 'photoPoll', 'pollResult',
    'order', 'product', 'businessOwnerJid', 'stickerPack', 'sharePhoneNumber', 'requestPhoneNumber', 'album',
    'interactiveAsTemplate', 'groupStatus', 'ephemeral', 'edit', 'viewOnce', 'viewOnceV2', 'viewOnceV2Extension',
    'viewOnceExt', 'spoiler', 'isLottie', 'secureMetaServiceLabel', 'code', 'links', 'table', 'richResponse',
    'html', 'source', 'trusted_sources', 'typename', 'headerText', 'botJid',
    'productList', 'thumbnail', 'audioFooter', 'caption', 'shop', 'shopSurface', 'collection', 'bizJid', 'id',
    'ptv', 'image', 'video', 'audio', 'sticker', 'document', 'mimetype', 'jpegThumbnail', 'gifPlayback', 'fileName',
    'seconds'
])

const buildRawMessageContent = (message) => {
    const rawPayload = { ...message }
    delete rawPayload.raw

    const helperKeys = Object.keys(rawPayload).filter(
        key => RAW_MODE_HELPER_KEYS.has(key) && !MESSAGE_PROTO_KEYS.has(key)
    )
    if (helperKeys.length) {
        throw new boom_1.Boom(`Raw mode does not support helper fields: ${helperKeys.join(', ')}`, { statusCode: 400 })
    }

    const invalidKeys = Object.keys(rawPayload).filter(key => !MESSAGE_PROTO_KEYS.has(key))
    if (invalidKeys.length) {
        throw new boom_1.Boom(`Raw mode payload contains unsupported top-level keys: ${invalidKeys.join(', ')}`, { statusCode: 400 })
    }

    if (!Object.keys(rawPayload).length) {
        throw new boom_1.Boom('Raw mode payload must include at least one proto message key', { statusCode: 400 })
    }

    return Types_1.WAProto.Message.fromObject(rawPayload)
}

/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
const extractUrlFromText = (text) => text.match(Defaults_1.URL_REGEX)?.[0]

const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text)

    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url)
            return urlInfo
        }

        catch (error) {
            logger?.warn({ trace: error.stack }, 'url generation failed')
        }
    }
}

const assertColor = async (color) => {
    let assertedColor

    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1
    }

    else {
        let hex = color.trim().replace('#', '')
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0')
        }
        assertedColor = parseInt(hex, 16)
        return assertedColor
    }
}

const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger
    let mediaType

    for (const key of Defaults_1.MEDIA_KEYS) {
        if (key in message) {
            mediaType = key
        }
    }

    if (!mediaType) {
        throw new boom_1.Boom('Invalid media type', { statusCode: 400 });
    }

    const uploadData = {
        ...message,
        media: message[mediaType]
    }

    delete uploadData[mediaType]

    // check if cacheable + generate cache key
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString()

    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file'
    }

    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType]
    }

    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey)
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit')
            const obj = Types_1.WAProto.Message.decode(mediaBuff)
            const key = `${mediaType}Message`
            Object.assign(obj[key], { ...uploadData, media: undefined })
            return obj
        }
    }

    const isNewsletter = !!options.jid && WABinary_1.isJidNewsletter(options.jid) || options.newsletter === true;

    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')
        const { filePath, fileSha256, fileLength } = await messages_media_1.getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger)
        if (mediaType === 'audio') {
            try {
                if (typeof uploadData.seconds === 'undefined') {
                    uploadData.seconds = await messages_media_1.getAudioDuration(filePath)
                }
                if (uploadData.ptt === true && typeof uploadData.waveform === 'undefined') {
                    uploadData.waveform = await messages_media_1.getAudioWaveform(filePath, logger)
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain newsletter audio metadata')
            }
        }
        const fileSha256B64 = fileSha256.toString('base64')
        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            newsletter: isNewsletter,
            timeoutMs: options.mediaUploadTimeoutMs
        })

        await fs_1.promises.unlink(filePath)

        const obj = Types_1.WAProto.Message.fromObject({
            // todo: add more support here
            [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined
            })
        })

        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage
            delete obj.videoMessage
        }

        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
        }

        return obj
    }

    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
    // Skip thumbnail compression for HD mode - generate higher quality thumbnail
    const isHDMode = 'hd' in uploadData && uploadData.hd === true
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined'
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation

    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await messages_media_1.encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options
    })

    const fileEncSha256B64 = fileEncSha256.toString('base64')

    const [{ mediaUrl, directPath }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            })
            logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
            return result
        })(),

        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await messages_media_1.generateThumbnail(
                        originalFilePath,
                        mediaType,
                        {
                            ...options,
                            // Pass HD mode flag for higher quality thumbnail
                            hdMode: isHDMode
                        }
                    )
                    uploadData.jpegThumbnail = thumbnail
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width
                        uploadData.height = originalImageDimensions.height

                        logger?.debug('set dimensions')
                    }

                    logger?.debug(isHDMode ? 'generated HD thumbnail' : 'generated thumbnail');
                }

                if (requiresDurationComputation) {
                    uploadData.seconds = await messages_media_1.getAudioDuration(originalFilePath)
                    logger?.debug('computed audio duration')
                }

                if (requiresWaveformProcessing) {
                    uploadData.waveform = await messages_media_1.getAudioWaveform(originalFilePath, logger)
                    logger?.debug('processed waveform')
                }

                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor)
                    logger?.debug('computed backgroundColor audio status')
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info')
            }
        })()
    ]).finally(async () => {
        try {
            await fs_1.promises.unlink(encFilePath)

            if (originalFilePath) {
                await fs_1.promises.unlink(originalFilePath)
            }

            logger?.debug('removed tmp files')
        }
        catch (error) {
            logger?.warn('failed to remove tmp file')
        }
    })

    const obj = Types_1.WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: generics_1.unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        })
    })

    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage
        delete obj.videoMessage
    }

    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
    }

    return obj
}

const hashImagePollOption = (optionName, fileSha256) => {
    const optionNameHash = crypto_2.sha256(Buffer.from(String(optionName), 'utf-8')).toString('hex')
    const mediaHash = Buffer.from(fileSha256).toString('base64')
    return crypto_2.sha256(Buffer.from(optionNameHash + mediaHash, 'utf-8')).toString('hex')
}

const generateWAMessageFromImagePoll = async (jid, content, relay, options) => {
    const selectableCount = content.selectableCount ?? 1
    const preparedOptions = []
    const pollOptions = []
    const messageSecret = content.messageSecret
        ? Buffer.from(content.messageSecret)
        : crypto_1.randomBytes(32)

    if (messageSecret.length !== 32) {
        throw new boom_1.Boom('photoPoll.messageSecret must be exactly 32 bytes', { statusCode: 400 })
    }

    for (const option of content.options) {
        const media = await prepareWAMessageMedia({ image: option.image }, {
            ...options,
            jid,
            newsletter: WABinary_1.isJidNewsletter(jid)
        })
        const imageMessage = media.imageMessage
        if (!imageMessage?.fileSha256) {
            throw new boom_1.Boom(`Could not calculate image hash for poll option "${option.name}"`, { statusCode: 500 })
        }

        preparedOptions.push(media)
        pollOptions.push({
            optionName: option.name,
            optionHash: hashImagePollOption(option.name, imageMessage.fileSha256)
        })
    }

    const pollContent = Types_1.WAProto.Message.fromObject({
        messageContextInfo: {
            messageSecret
        },
        pollCreationMessageV3: {
            name: content.name,
            options: pollOptions,
            selectableOptionsCount: selectableCount,
            pollContentType: Types_1.WAProto.Message.PollContentType.IMAGE
        }
    })
    const pollOptionsForMessage = {
        ...options,
        messageId: options.messageId || generics_1.generateMessageID(options.userJid)
    }
    const pollMessage = generateWAMessageFromContent(jid, pollContent, pollOptionsForMessage)

    await relay(pollMessage.message, {
        messageId: pollMessage.key.id,
        additionalNodes: [
            { tag: 'meta', attrs: { polltype: 'creation', contenttype: 'image' } },
            ...(options.additionalNodes || [])
        ]
    })
    await options.onMessageSent?.(pollMessage)

    for (const media of preparedOptions) {
        const optionContent = Types_1.WAProto.Message.fromObject({
            messageContextInfo: {
                messageAssociation: {
                    associationType: Types_1.WAProto.MessageAssociation.AssociationType.MEDIA_POLL,
                    parentMessageKey: pollMessage.key
                }
            },
            pollCreationOptionImageMessage: {
                message: media
            }
        })
        const optionMessage = generateWAMessageFromContent(jid, optionContent, {
            ...options,
            messageId: generics_1.generateMessageID(options.userJid),
            quoted: undefined
        })

        await relay(optionMessage.message, {
            messageId: optionMessage.key.id,
            additionalNodes: [
                { tag: 'meta', attrs: { message_association_type: 'media_poll' } },
                ...(options.additionalNodes || [])
            ]
        })
        await options.onMessageSent?.(optionMessage)
    }

    return pollMessage
}

const prepareAlbumMessageContent = async (jid, albums, options) => {
    let mediaHandle
    let mediaMsg
    let message = []

    const albumMsg = generateWAMessageFromContent(jid, {
        albumMessage: {
            expectedImageCount: albums.filter(item => 'image' in item).length,
            expectedVideoCount: albums.filter(item => 'video' in item).length
        }
    }, options)

    await options.sock.relayMessage(jid, albumMsg.message, {
        messageId: albumMsg.key.id
    })

    for (const i in albums) {
        const media = albums[i]

        if ('image' in media) {
            mediaMsg = await generateWAMessage(jid, {
                image: media.image,
                ...media,
                ...options
            }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, { ...opts, newsletter: WABinary_1.isJidNewsletter(jid) })
                    mediaHandle = up.handle
                    return up
                },
                ...options
            })
        } else if ('video' in media) {
            mediaMsg = await generateWAMessage(jid, {
                video: media.video,
                ...media,
                ...options
            }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, { ...opts, newsletter: WABinary_1.isJidNewsletter(jid) })
                    mediaHandle = up.handle
                    return up
                },
                ...options
            })
        }

        if (mediaMsg) {
            mediaMsg.message.messageContextInfo = {
                messageSecret: crypto_1.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: albumMsg.key
                }
            }
        }

        message.push(mediaMsg)
    }

    return message
}

const prepareDisappearingMessageSettingContent = (expiration) => {
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: Types_1.WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration: expiration ? expiration : 0
                }
            }
        }
    }

    return Types_1.WAProto.Message.fromObject(content)
}

/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message

    if (!content) {
        throw new boom_1.Boom('no content in message', { statusCode: 400 })
    }

    // hacky copy
    content = normalizeMessageContent(content)
    content = WAProto_1.proto.Message.decode(WAProto_1.proto.Message.encode(content).finish())

    let key = Object.keys(content)[0]
    let score = content[key].contextInfo?.forwardingScore || 0

    if (forceForward) score += forceForward ? forceForward : 1

    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] }
        delete content.conversation
        key = 'extendedTextMessage'
    }

    if (score > 0) {
        content[key].contextInfo = { forwardingScore: score, isForwarded: true }
    }

    else {
        content[key].contextInfo = {}
    }

    return content
}

/**
 * Converts shorthand nativeFlow button objects into the WA-compatible
 * { name, buttonParamsJson } format that WhatsApp expects.
 *
 * Supported shorthand fields on each button:
 *   id       → quick_reply
 *   copy     → cta_copy
 *   url      → cta_url  (useWebview toggles webview mode)
 *   call     → cta_call
 *   sections → single_select
 *
 * Supported shorthand fields on the parent message/card:
 *   offerText / offerCode / offerUrl / offerExpiration → limited_time_offer
 *   optionText / optionTitle                           → bottom_sheet
 *
 * @param {object} messageOrCard - the message or card object
 *   containing either { nativeFlow: [...] } or
 *   { nativeFlow: { buttons: [...] } }
 */
const prepareNativeFlowButtons = (messageOrCard) => {
    const raw = messageOrCard.nativeFlow
    // accept both Array and { buttons: Array } shapes
    const buttons = Array.isArray(raw) ? raw : (raw?.buttons || [])
    const messageParamsJson = {}

    if (messageOrCard.offerText) {
        messageParamsJson.limited_time_offer = {
            text: messageOrCard.offerText,
            url: messageOrCard.offerUrl || '',
            copy_code: messageOrCard.offerCode,
            expiration_time: messageOrCard.offerExpiration
        }
    }

    if (messageOrCard.optionText) {
        messageParamsJson.bottom_sheet = {
            in_thread_buttons_limit: 1,
            divider_indices: Array.from({ length: buttons.length }, (_, i) => i),
            list_title: messageOrCard.optionTitle || '📄 Select Options',
            button_title: messageOrCard.optionText
        }
    }

    return {
        buttons: buttons.map(button => {
            const buttonText = button.text || button.buttonText
            const buttonIcon = button.icon ? String(button.icon).toUpperCase() : undefined

            if (button.id != null) {
                return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '👉 Click',
                        id: button.id,
                        icon: buttonIcon
                    })
                }
            } else if (button.copy != null) {
                return {
                    name: 'cta_copy',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '📋 Copy',
                        copy_code: button.copy,
                        icon: buttonIcon
                    })
                }
            } else if (button.url != null) {
                return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '🌐 Visit',
                        url: button.url,
                        merchant_url: button.url,
                        webview_interaction: button.useWebview || false,
                        icon: buttonIcon
                    })
                }
            } else if (button.call != null) {
                return {
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '📞 Call',
                        phone_number: button.call,
                        icon: buttonIcon
                    })
                }
            } else if (button.sections != null) {
                return {
                    name: 'single_select',
                    buttonParamsJson: JSON.stringify({
                        title: buttonText || '📋 Select',
                        sections: button.sections,
                        icon: buttonIcon
                    })
                }
            }
            // already in { name, buttonParamsJson } format – pass through
            return button
        }),
        messageParamsJson: JSON.stringify(messageParamsJson)
    }
}

/**
 * Build the mention-related portion of contextInfo.
 * - `mentions`: populates mentionedJid with individual JIDs
 * - `mentionAll`: sets nonJidMentions=1 and empty mentionedJid/groupMentions
 *   to trigger a "mention all" notification for every group member
 *
 * Usage: spread into contextInfo alongside message.contextInfo
 * e.g. contextInfo: { ...(message.contextInfo || {}), ...buildMentionContextInfo(message) }
 */
const buildMentionContextInfo = (message) => {
    if (message.mentionAll) {
        return {
            nonJidMentions: 1
        }
    }

    if (message.mentions?.length) {
        return { mentionedJid: message.mentions }
    }

    return {}
}

const generatePollUpdateMessage = async (pollUpdate, options) => {
    const pollKey = pollUpdate?.pollCreationMessageKey
    if (!pollKey?.id || !pollKey.remoteJid) {
        throw new boom_1.Boom('pollUpdate.pollCreationMessageKey must include remoteJid and id', { statusCode: 400 })
    }
    if (!Array.isArray(pollUpdate.votes) || !pollUpdate.votes.length ||
        pollUpdate.votes.some(vote => typeof vote !== 'string')) {
        throw new boom_1.Boom('pollUpdate.votes must be a non-empty array of option names', { statusCode: 400 })
    }

    const pollMessage = pollUpdate.pollMessage ||
        (typeof options.getMessage === 'function'
            ? await options.getMessage(pollKey)
            : undefined)
    if (!pollMessage) {
        throw new boom_1.Boom('Poll creation message not found; configure getMessage or pass pollUpdate.pollMessage', { statusCode: 400 })
    }

    const pollContent = normalizeMessageContent(pollMessage.message || pollMessage)
    const pollSecret = pollContent?.messageContextInfo?.messageSecret
    const poll = pollContent?.pollCreationMessageV5 ||
        pollContent?.pollCreationMessageV6 ||
        pollContent?.pollCreationMessageV4 ||
        pollContent?.pollCreationMessageV3 ||
        pollContent?.pollCreationMessageV2 ||
        pollContent?.pollCreationMessage
    if (!pollSecret || !poll?.name || !Array.isArray(poll.options)) {
        throw new boom_1.Boom('Poll creation message is missing its secret or options', { statusCode: 400 })
    }
    if (pollMessage.key?.id && pollMessage.key.id !== pollKey.id) {
        throw new boom_1.Boom('Poll creation message does not match pollCreationMessageKey.id', { statusCode: 400 })
    }

    const meJid = options.userLid || options.userJid
    if (!meJid) {
        throw new boom_1.Boom('Authenticated user JID is required to vote in a poll', { statusCode: 400 })
    }
    const voterJid = WABinary_1.jidNormalizedUser(meJid)
    const creatorJid = pollKey.fromMe
        ? voterJid
        : WABinary_1.jidNormalizedUser(pollKey.participant || pollKey.remoteJid)
    if (!voterJid || !creatorJid) {
        throw new boom_1.Boom('Could not resolve poll creator or voter JID', { statusCode: 400 })
    }

    const optionHashes = new Map(
        poll.options.map(option => [
            option.optionName,
            crypto_2.sha256(Buffer.from(option.optionName || ''))
        ])
    )
    const selectedOptions = []
    for (const vote of pollUpdate.votes) {
        const hash = optionHashes.get(vote)
        if (!hash) {
            throw new boom_1.Boom(`Unknown poll option: ${vote}`, { statusCode: 400 })
        }
        selectedOptions.push(hash)
    }
    if (new Set(pollUpdate.votes).size !== pollUpdate.votes.length) {
        throw new boom_1.Boom('pollUpdate.votes cannot contain duplicate options', { statusCode: 400 })
    }
    if (poll.selectableOptionsCount > 0 && selectedOptions.length > poll.selectableOptionsCount) {
        throw new boom_1.Boom(`Poll accepts at most ${poll.selectableOptionsCount} selected option(s)`, { statusCode: 400 })
    }

    const sign = Buffer.concat([
        Buffer.from(pollKey.id),
        Buffer.from(creatorJid),
        Buffer.from(voterJid),
        Buffer.from('Poll Vote'),
        new Uint8Array([1])
    ])
    const key0 = crypto_2.hmacSign(pollSecret, new Uint8Array(32), 'sha256')
    const encryptionKey = crypto_2.hmacSign(sign, key0, 'sha256')
    const encIv = crypto_1.randomBytes(12)
    const aad = Buffer.from(`${pollKey.id}\u0000${voterJid}`)
    const payload = WAProto_1.proto.Message.PollVoteMessage
        .encode({ selectedOptions })
        .finish()
    const encPayload = crypto_2.aesEncryptGCM(payload, encryptionKey, encIv, aad)

    return {
        pollUpdateMessage: {
            pollCreationMessageKey: pollKey,
            vote: { encPayload, encIv },
            metadata: {
                pollNameHash: crypto_2.sha256(Buffer.from(poll.name))
            },
            senderTimestampMs: Date.now()
        }
    }
}

const generateWAMessageContent = async (message, options) => {
    if ('raw' in message && message.raw === true) {
        return buildRawMessageContent(message)
    }

    let m = {}
    if ('text' in message) {
        const extContent = { text: message.text }
        let urlInfo = message.linkPreview

        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)
        }

        if (urlInfo) {
            extContent.canonicalUrl = urlInfo['canonical-url']
            extContent.matchedText = urlInfo['matched-text']
            extContent.jpegThumbnail = urlInfo.jpegThumbnail
            extContent.description = urlInfo.description
            extContent.title = urlInfo.title
            extContent.previewType = 0
            const img = urlInfo.highQualityThumbnail

            if (img) {
                extContent.thumbnailDirectPath = img.directPath
                extContent.mediaKey = img.mediaKey
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
                extContent.thumbnailWidth = img.width
                extContent.thumbnailHeight = img.height
                extContent.thumbnailSha256 = img.fileSha256
                extContent.thumbnailEncSha256 = img.fileEncSha256
            }

            if (urlInfo.linkPreviewMetadata) {
                extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata
            }
        }

        if (message.favicon) {
            const { imageMessage: faviconImage } = await prepareWAMessageMedia(
                { image: message.favicon },
                { ...options, mediaTypeOverride: 'thumbnail-link' }
            )
            if (faviconImage) {
                extContent.faviconMMSMetadata = {
                    thumbnailDirectPath: faviconImage.directPath,
                    mediaKey: faviconImage.mediaKey,
                    mediaKeyTimestamp: faviconImage.mediaKeyTimestamp,
                    thumbnailWidth: faviconImage.width,
                    thumbnailHeight: faviconImage.height,
                    thumbnailSha256: faviconImage.fileSha256,
                    thumbnailEncSha256: faviconImage.fileEncSha256
                }
            }
        }

        const backgroundColor = options.backgroundColor || message.backgroundColor
        if (backgroundColor) {
            extContent.backgroundArgb = await assertColor(backgroundColor)
        }
        const textColor = options.textColor || message.textColor
        if (textColor) {
            extContent.textArgb = await assertColor(textColor)
        }
        if (options.font || message.font) {
            extContent.font = options.font || message.font
        }

        extContent.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m.extendedTextMessage = extContent
    }

    else if ('contacts' in message) {
        const contactLen = message.contacts.contacts.length

        let contactMessage

        if (!contactLen) {
            throw new boom_1.Boom('require atleast 1 contact', { statusCode: 400 })
        }

        if (contactLen === 1) {
            contactMessage = {
                contactMessage: Types_1.WAProto.Message.ContactMessage.fromObject(message.contacts.contacts[0])
            }
        }

        else {
            contactMessage = {
                contactsArrayMessage: Types_1.WAProto.Message.ContactsArrayMessage.fromObject(message.contacts)
            }
        }

        const [type] = Object.keys(contactMessage)

        contactMessage[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = contactMessage
    }

    else if ('location' in message) {
        let locationMessage

        if (message.live) {
            locationMessage = {
                liveLocationMessage: Types_1.WAProto.Message.LiveLocationMessage.fromObject(message.location)
            }
        }

        else {
            locationMessage = {
                locationMessage: Types_1.WAProto.Message.LocationMessage.fromObject(message.location)
            }
        }

        const [type] = Object.keys(locationMessage)

        locationMessage[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = locationMessage
    }

    else if ('react' in message) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now()
        }

        m.reactionMessage = Types_1.WAProto.Message.ReactionMessage.fromObject(message.react)
    }

    else if ('delete' in message) {
        m.protocolMessage = {
            key: message.delete,
            type: Types_1.WAProto.Message.ProtocolMessage.Type.REVOKE
        }
    }

    else if ('forward' in message) {
        const mess = generateForwardMessageContent(message.forward, message.force)
        const [type] = Object.keys(mess)

        mess[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = mess
    }

    else if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean' ?
            (message.disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
            message.disappearingMessagesInChat
        m = prepareDisappearingMessageSettingContent(exp)
    }

    else if ('groupInvite' in message) {
        m.groupInviteMessage = {}

        m.groupInviteMessage.inviteCode = message.groupInvite.code
        m.groupInviteMessage.inviteExpiration = message.groupInvite.expiration
        m.groupInviteMessage.caption = message.groupInvite.caption
        m.groupInviteMessage.groupJid = message.groupInvite.jid
        m.groupInviteMessage.groupName = message.groupInvite.name
        m.groupInviteMessage.contextInfo = message.contextInfo

        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid)
            const { thumbnail } = await messages_media_1.generateThumbnail(pfpUrl, 'image')
            m.groupInviteMessage.jpegThumbnail = thumbnail
        }

        m.groupInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('adminInvite' in message) {
        m.newsletterAdminInviteMessage = {}

        m.newsletterAdminInviteMessage.newsletterJid = message.adminInvite.jid
        m.newsletterAdminInviteMessage.newsletterName = message.adminInvite.name
        m.newsletterAdminInviteMessage.caption = message.adminInvite.caption
        m.newsletterAdminInviteMessage.inviteExpiration = message.adminInvite.expiration
        m.newsletterAdminInviteMessage.contextInfo = message.contextInfo

        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.adminInvite.jid)
            const { thumbnail } = await messages_media_1.generateThumbnail(pfpUrl, 'image')
            m.newsletterAdminInviteMessage.jpegThumbnail = thumbnail
        }

        m.newsletterAdminInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('pin' in message) {
        m.pinInChatMessage = {}
        m.messageContextInfo = {}
        m.pinInChatMessage.key = message.pin.key ?? message.pin 
        m.pinInChatMessage.type = message.pin?.type ?? message.type ?? 1
        m.pinInChatMessage.senderTimestampMs = message.pin?.time ?? message.time ?? Date.now()
        m.messageContextInfo.messageAddOnDurationInSecs = (message.pin?.type ?? (message.type === 1)) ? (message.pin?.time ?? message.time ?? 86400)  : 0;
      m.messageContextInfo.messageAddOnDurationInSecs = (message.pin?.type ?? message.type ?? 1) === 1 ? (message.pin?.time ?? message.time ?? 86400) : 0;
        m.messageContextInfo.messageAddOnExpiryType = WAProto_1.proto.MessageContextInfo.MessageAddonExpiryType.STATIC
    }
    else if ('keep' in message) {
        m.keepInChatMessage = {}

        m.keepInChatMessage.key = message.keep.key ?? message.keep
        m.keepInChatMessage.keepType = message.keep?.type ?? 1
        m.keepInChatMessage.timestampMs = message.keep?.time ?? Date.now()
    }
    else if ('copy' in message) {
          let interactiveMessage = {
        body: { text: copy.text ?? 'Your code is ready' },
        footer: { text: copy.footer ?? 'Tap to copy' },
        header: { hasMediaAttachment: false },
        nativeFlowMessage: {
            buttons: [{ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: copy.button ?? 'Copy', copy_code: copy.code }) }]
        }
    }
        m.interactiveMessage = Types_1.WAProto.Message.InteractiveMessage.fromObject(interactiveMessage);
        m.interactiveMessage.contextInfo = {
            ...(interactiveMessage.contextInfo || {}),
            ...buildMentionContextInfo(message)
        };
    }
    else if ('call' in message) {
        m.scheduledCallCreationMessage = {}

        m.scheduledCallCreationMessage.scheduledTimestampMs = message.call?.time ?? Date.now()
        m.scheduledCallCreationMessage.callType = message.call?.type ?? 1
        m.scheduledCallCreationMessage.title = message.call?.name ?? 'Call Creation'

        m.scheduledCallCreationMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('paymentInvite' in message) {
        m.messageContextInfo = {}
        m.paymentInviteMessage = {}

        m.paymentInviteMessage.expiryTimestamp = message.paymentInvite?.expiry || 0
        m.paymentInviteMessage.serviceType = message.paymentInvite?.type || 2

        m.paymentInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('buttonReply' in message) {
        switch (message.type) {
            case 'list':
                m.listResponseMessage = {
                    title: message.buttonReply.title,
                    description: message.buttonReply.description,
                    singleSelectReply: {
                        selectedRowId: message.buttonReply.rowId
                    },
                    lisType: WAProto_1.proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
                }
                break
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                }
                break
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: WAProto_1.proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                }
                break
            case 'interactive':
                m.interactiveResponseMessage = {
                    body: {
                        text: message.buttonReply.displayText,
                        format: WAProto_1.proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
                    },
                    nativeFlowResponseMessage: {
                        name: message.buttonReply.nativeFlows.name,
                        paramsJson: message.buttonReply.nativeFlows.paramsJson,
                        version: message.buttonReply.nativeFlows.version
                    }
                }
                break
        }
    }

    else if ('ptv' in message && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options)
        m.ptvMessage = videoMessage
    }

    else if ('album' in message) {
        const imageMessages = message.album.filter(item => 'image' in item)
        const videoMessages = message.album.filter(item => 'video' in item)

        m.albumMessage = Types_1.WAProto.Message.AlbumMessage.fromObject({
            expectedImageCount: imageMessages.length,
            expectedVideoCount: videoMessages.length
        })
    }

    else if ('order' in message) {
        m.orderMessage = Types_1.WAProto.Message.OrderMessage.fromObject(message.order)
        m.orderMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('event' in message) {
        m.eventMessage = Types_1.WAProto.Message.EventMessage.fromObject(message.event)

        if (!message.event.startTime) {
            m.eventMessage.startTime = generics_1.unixTimestampSeconds() + 86400
        }

        if (options.getCallLink && message.event.call) {
            const link = await options.getCallLink(message.event.call, m.eventMessage.startTime)
            m.eventMessage.joinLink = link
        }


        m.eventMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('product' in message) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options)

        m.productMessage = Types_1.WAProto.Message.ProductMessage.fromObject({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage,
            }
        })

        m.productMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('pollResult' in message) {
        if (!Array.isArray(message.pollResult.values)) {
            throw new boom_1.Boom('Invalid pollResult values', { statusCode: 400 })
        }

        const pollResultSnapshotMessage = {
            name: message.pollResult.name,
            pollVotes: message.pollResult.values.map(([optionName, optionVoteCount]) => ({
                optionName,
                optionVoteCount
            }))
        }

        pollResultSnapshotMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m.pollResultSnapshotMessage = pollResultSnapshotMessage
    }

    else if ('pollUpdate' in message) {
        m = await generatePollUpdateMessage(message.pollUpdate, options)
    }

else if ('poll' in message) {
        const poll = message.poll
        const values = Array.isArray(poll.values)
            ? poll.values
            : Array.isArray(poll.options)
                ? poll.options.map(option => typeof option === 'string' ? option : option?.optionName)
                : undefined
        const selectableCount = poll.selectableCount ?? 0
        if (!Array.isArray(values) || values.some(option => typeof option !== 'string')) {
            throw new boom_1.Boom('poll.values must be an array of option names', { statusCode: 400 })
        }
        if (!Number.isInteger(selectableCount) || selectableCount < 0 || selectableCount > values.length) {
            throw new boom_1.Boom(`poll.selectableCount should be >= 0 and <= ${values.length}`, { statusCode: 400 })
        }
        if (poll.hideParticipantName !== undefined && typeof poll.hideParticipantName !== 'boolean') {
            throw new boom_1.Boom('poll.hideParticipantName must be a boolean', { statusCode: 400 })
        }
        if (poll.allowAdd !== undefined && typeof poll.allowAdd !== 'boolean') {
            throw new boom_1.Boom('poll.allowAdd must be a boolean', { statusCode: 400 })
        }
        m.messageContextInfo = {
            messageSecret: poll.messageSecret || crypto_1.randomBytes(32),
        };
        const pollCreationMessage = {
            name: poll.name || poll.question || poll.text,
            selectableOptionsCount: selectableCount,
            options: values.map(optionName => ({ optionName })),
            ...(poll.contextInfo ? { contextInfo: poll.contextInfo } : {}),
        };
        if (poll.pollType === 1) {
            m.pollCreationMessageV5 = {
                name: poll.name || poll.question || poll.text,
                options: values.map(optionName => ({ optionName })),
                correctAnswer: { optionName: String(poll.correctAnswer ?? poll.answer) },
                pollType: 1,
                selectableOptionsCount: 1
            };
        } else if (poll.hideParticipantName || poll.allowAdd) {
            m.pollCreationMessageV6 = {
                ...pollCreationMessage,
                ...(poll.hideParticipantName ? { hideParticipantName: true } : {}),
                ...(poll.allowAdd ? { allowAddOption: true } : {})
            };
        } else if (poll.toAnnouncementGroup) {
            // poll v2 is for community announcement groups (single select and multiple)
            m.pollCreationMessageV2 = pollCreationMessage;
        } else if (poll.pollType !== 1) {
            if (selectableCount === 1) {
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                 m.pollCreationMessage = pollCreationMessage;
            }
        }
    }

    else if ('payment' in message) {
        const requestPaymentMessage = {
            amount: {
                currencyCode: message.payment?.currency || 'MAD',
                offset: message.payment?.offset || 0,
                value: message.payment?.amount || 999999999
            },
            expiryTimestamp: message.payment?.expiry || 0,
            amount1000: message.payment?.amount || 999999999 * 1000,
            currencyCodeIso4217: message.payment?.currency || 'MAD',
            requestFrom: message.payment?.from || '0@s.whatsapp.net',
            noteMessage: {
                extendedTextMessage: {
                    text: message.payment?.note || 'Notes'
                }
            },
            background: {
                placeholderArgb: message.payment?.image?.placeholderArgb || 4278190080,
                textArgb: message.payment?.image?.textArgb || 4294967295,
                subtextArgb: message.payment?.image?.subtextArgb || 4294967295,
                type: 1
            }
        }

        requestPaymentMessage.noteMessage.extendedTextMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m.requestPaymentMessage = requestPaymentMessage
    }

    else if ('stickerPack' in message) {
        const { stickers, cover, name, publisher, packId, description } = message.stickerPack

        const { zip } = require('fflate')

        const stickerData = {}
        const stickerPromises = stickers.map(async (s, i) => {
            const { stream } = await messages_media_1.getStream(s.sticker)
            const buffer = await messages_media_1.toBuffer(stream)
            const hash = crypto_2.sha256(buffer).toString('base64url')
            const fileName = `${i.toString().padStart(2, '0')}_${hash}.webp`
            stickerData[fileName] = [new Uint8Array(buffer), { level: 0 }]

            return {
                fileName,
                mimetype: 'image/webp',
                isAnimated: s.isAnimated || false,
                isLottie: s.isLottie || false,
                emojis: s.emojis || [],
                accessibilityLabel: s.accessibilityLabel || ''
            }
        })

        const stickerMetadata = await Promise.all(stickerPromises)

        const zipBuffer = await new Promise((resolve, reject) => {
            zip(stickerData, (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(Buffer.from(data))
                }
            })
        })

        const coverBuffer = await messages_media_1.toBuffer((await messages_media_1.getStream(cover)).stream)

        const [stickerPackUpload, coverUpload] = await Promise.all([
            messages_media_1.encryptedStream(zipBuffer, 'sticker-pack', { logger: options.logger, opts: options.options }),
            prepareWAMessageMedia({ image: coverBuffer }, { ...options, mediaTypeOverride: 'image' })
        ])

        const stickerPackUploadResult = await options.upload(stickerPackUpload.encFilePath, {
            fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
            mediaType: 'sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs
        })


        const coverImage = coverUpload.imageMessage
        const imageDataHash = crypto_2.sha256(coverBuffer).toString('base64')
        const stickerPackId = packId || generics_1.generateMessageID()

        m.stickerPackMessage = {
            name,
            publisher,
            stickerPackId,
            packDescription: description,
            stickerPackOrigin: WAProto_1.proto.Message.StickerPackMessage.StickerPackOrigin.THIRD_PARTY,
            stickerPackSize: stickerPackUpload.fileLength,
            stickers: stickerMetadata,
            fileSha256: stickerPackUpload.fileSha256,
            fileEncSha256: stickerPackUpload.fileEncSha256,
            mediaKey: stickerPackUpload.mediaKey,
            directPath: stickerPackUploadResult.directPath,
            fileLength: stickerPackUpload.fileLength,
            mediaKeyTimestamp: generics_1.unixTimestampSeconds(),
            trayIconFileName: `${stickerPackId}.png`,
            imageDataHash,
            thumbnailDirectPath: coverImage.directPath,
            thumbnailSha256: coverImage.fileSha256,
            thumbnailEncSha256: coverImage.fileEncSha256,
            thumbnailHeight: coverImage.height,
            thumbnailWidth: coverImage.width
        }

        m.stickerPackMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }
    }

    else if ('sharePhoneNumber' in message) {
        m.protocolMessage = {
            type: Types_1.WAProto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        }
    }

    else if ('requestPhoneNumber' in message) {
        m.requestPhoneNumberMessage = {}
    }
    else if ('requestPayment' in message) {
    let acc = [];

    // 1. إضافة حساب CIH Bank إذا كان مفعل
    if (message.requestPayment.cih) {
        acc.push({
            "type": "payment_account",
            "payment_account": {
                "account_type": "bank_account",
                "identifier_type": "rib",
                "identifier_value": "230780283374021101200097",
                "institution_name": "CIH Bank",
                "beneficiary_name": "Ouahssoune Hamid"
            }
        });
    }
    if (message.requestPayment.orange) {
        acc.push({
            "type": "payment_account",
            "payment_account": {
                "account_type": "mobile_money",
                "identifier_type": "phone_number",
                "identifier_value": "0669005128",
                "institution_name": "Orange Money",
                "beneficiary_name": "Hamid Ouahssoune"
            }
        });
    }

    // بناء كائن الـ nativeFlowMessage وتضمين حسابات الدفع المتوفرة
    let interactiveMessageData = {
        nativeFlowMessage: {
            "buttons": [
                {
                    "name": "review_and_pay",
                    "buttonParamsJson": JSON.stringify({
                        "currency": "MAD",
                        "payment_type": "upr",
                        "total_amount": {
                            "value": message.requestPayment.amount * 100 || 10000,
                            "offset": 100
                        },
                        "reference_id": "4WH1ZGJ1661",
                        "type": "physical-goods",
                        "order": {
                            "status": "pending",
                            "description": "Payment Request",
                            "order_type": "PAYMENT_REQUEST"
                        },
                        "payment_settings": acc,
                        "share_payment_status": true,
                        "is_soft_deleted": false
                    })
                }
            ]
        }
    };

    // ربط الكائن المصمم بالشكل الصحيح مع رسالة الـ Baileys
    m.interactiveMessage = Types_1.WAProto.Message.InteractiveMessage.fromObject(interactiveMessageData);
    
    m.interactiveMessage.contextInfo = {
        ...(message.interactiveMessage?.contextInfo || message.contextInfo || {}),
        ...buildMentionContextInfo(message)
    };
}
    else if ('interactiveMessage' in message) {
        m.interactiveMessage = Types_1.WAProto.Message.InteractiveMessage.fromObject(message.interactiveMessage);
        m.interactiveMessage.contextInfo = {
            ...(message.interactiveMessage.contextInfo || message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        };
    }
    else if ('buttonsMessage' in message) {
        m.buttonsMessage = Types_1.WAProto.Message.ButtonsMessage.fromObject(message.buttonsMessage);
        m.buttonsMessage.contextInfo = {
            ...(message.buttonsMessage.contextInfo || message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        };
    }
    else if ('listMessage' in message) {
        m.listMessage = Types_1.WAProto.Message.ListMessage.fromObject(message.listMessage);
        m.listMessage.contextInfo = {
            ...(message.listMessage.contextInfo || message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        };
    }
    else if ('templateMessage' in message) {
        m.templateMessage = Types_1.WAProto.Message.TemplateMessage.fromObject(message.templateMessage);
        m.templateMessage.contextInfo = {
            ...(message.templateMessage.contextInfo || message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        };
    }
    else if ('viewOnceMessage' in message) {
        m.viewOnceMessage = Types_1.WAProto.Message.fromObject(message.viewOnceMessage);
    }
    else if ('viewOnceMessageV2' in message) {
        m.viewOnceMessageV2 = Types_1.WAProto.Message.fromObject(message.viewOnceMessageV2);
    }

    else if ('html' in message) {
        m = rich_message_utils_1.prepareRichHtmlMessage(message).message
    }
    else if ('code' in message || 'links' in message || 'table' in message || 'richResponse' in message) {
        m = rich_message_utils_1.prepareRichResponseMessage(message)
    }
    else if ("qResponse" in message) {
        m.questionResponseMessage = WAProto_1.proto.Message.QuestionResponseMessage.create({
            key: message.qResponse.key,
            text: message.qResponse.text ?? ''
        });
    }
    else if ("qReply" in message) {
        m.questionReplyMessage = WAProto_1.proto.Message.FutureProofMessage.create({
            message: {
                extendedTextMessage: WAProto_1.proto.Message.ExtendedTextMessage.create({
                    text: message.qReply.text,
                    contextInfo: {
                        ...(message.qReply.contextInfo || {}),
                        questionReplyQuotedMessage: {
                            serverQuestionId: Number(message.qReply.id),
                            ...(message.qReply.quotedQuestion ? { quotedQuestion: message.qReply.quotedQuestion } : {}),
                            ...(message.qReply.quotedResponse ? { quotedResponse: message.qReply.quotedResponse } : {})
                        }
                    }
                })
            }
        });
    }
    else if ("question" in message) {
        const qText = typeof message.question === "string" ? message.question : message.question.text;
        m.questionMessage = WAProto_1.proto.Message.FutureProofMessage.create({
            message: {
                extendedTextMessage: { text: qText, contextInfo: { isQuestion: true } }
            }
        });
    }
    else {
        const hasMedia = Defaults_1.MEDIA_KEYS.some(key => key in message)
        if (hasMedia) {
            const mess = await prepareWAMessageMedia(message, options)
            const [type] = Object.keys(mess)

            mess[type].contextInfo = {
                ...(message.contextInfo || {}),
                ...buildMentionContextInfo(message)
            }

            m = mess
        }
    }
	if ('byai' in message && message.byai === true) {
		if (m.videoMessage) {
			m.videoMessage.videoSourceType = WAProto_1.proto.Message.VideoMessage.VideoSourceType.AI_GENERATED
		}
		if (m.imageMessage) {
			m.imageMessage.imageSourceType = WAProto_1.proto.Message.ImageMessage.ImageSourceType.AI_GENERATED
		}
	}
    if ('sections' in message && !!message.sections) {
        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            sections: message.sections,
            listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT
        }

        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { listMessage }
    }

    else if ('productList' in message && !!message.productList) {
        const thumbnail = message.thumbnail ? await messages_media_1.generateThumbnail(message.thumbnail, 'image') : null

        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            productListInfo: {
                productSections: message.productList,
                headerImage: {
                    productId: message.productList[0].products[0].productId,
                    jpegThumbnail: thumbnail?.thumbnail || null
                },
                businessOwnerJid: message.businessOwnerJid
            },
            listType: WAProto_1.proto.Message.ListMessage.ListType.PRODUCT_LIST
        }

        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { listMessage }
    }

    else if ('buttons' in message && !!message.buttons) {
        const buttonsMessage = {
            buttons: message.buttons.map(button => {
                const buttonText = button.text || button.buttonText;
                if (button.sections) {
                    return {
                        nativeFlowInfo: {
                            name: 'single_select',
                            paramsJson: JSON.stringify({
                                title: buttonText,
                                sections: button.sections
                            })
                        },
                        type: WAProto_1.proto.Message.ButtonsMessage.Button.Type.NATIVE_FLOW
                    };
                }
                else if (button.name) {
                    return {
                        nativeFlowInfo: {
                            name: button.name,
                            paramsJson: button.paramsJson
                        },
                        type: WAProto_1.proto.Message.ButtonsMessage.Button.Type.NATIVE_FLOW
                    };
                }
                return {
                    buttonId: button.id || button.buttonId,
                    buttonText: typeof buttonText === 'string' ? { displayText: buttonText } : buttonText,
                    type: button.type || WAProto_1.proto.Message.ButtonsMessage.Button.Type.RESPONSE
                };
            })
        }

        if ('text' in message) {
            buttonsMessage.contentText = message.text
            buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.EMPTY
        }

        else {
            if ('caption' in message) {
                buttonsMessage.contentText = message.caption
            }

            const type = Object.keys(m)[0].replace('Message', '').toUpperCase()

            buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType[type]

            Object.assign(buttonsMessage, m)
        }

        if ('footer' in message && !!message.footer) {
            buttonsMessage.footerText = message.footer
        }

        if ('title' in message && !!message.title) {
            buttonsMessage.text = message.title
            buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.TEXT
        }

        buttonsMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { buttonsMessage }
    }

    else if ('templateButtons' in message && !!message.templateButtons) {
        const hydratedTemplate = {
            hydratedButtons: message.templateButtons.map((button, i) => {
                const buttonText = button.text || button.buttonText;
                if (button.id !== undefined) {
                    return {
                        index: i,
                        quickReplyButton: {
                            displayText: buttonText || '👉🏻 Click',
                            id: button.id
                        }
                    };
                }
                else if (button.url !== undefined) {
                    return {
                        index: i,
                        urlButton: {
                            displayText: buttonText || '🌐 Visit',
                            url: button.url
                        }
                    };
                }
                else if (button.call !== undefined) {
                    return {
                        index: i,
                        callButton: {
                            displayText: buttonText || '📞 Call',
                            phoneNumber: button.call
                        }
                    };
                }
                button.index = button.index || i;
                return button;
            })
        }

        if ('text' in message) {
            hydratedTemplate.hydratedContentText = message.text
        }

        else {
            if ('caption' in message) {
                hydratedTemplate.hydratedTitleText = message.title
                hydratedTemplate.hydratedContentText = message.caption
            }

            Object.assign(hydratedTemplate, m)
        }

        if ('footer' in message && !!message.footer) {
            hydratedTemplate.hydratedFooterText = message.footer
        }

        hydratedTemplate.templateId = message.id || 'template-' + Date.now();

        hydratedTemplate.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = {
            templateMessage: {
                hydratedFourRowTemplate: hydratedTemplate,
                hydratedTemplate: hydratedTemplate
            }
        }
    }

    else if (('interactiveButtons' in message && !!message.interactiveButtons) || ('nativeFlow' in message && !!message.nativeFlow)) {
        // Convert shorthand nativeFlow buttons to WA format if needed
        const rawButtons = message.interactiveButtons || message.nativeFlow
        const isShorthand = Array.isArray(rawButtons) &&
            rawButtons.length > 0 &&
            !rawButtons[0].name

        const convertedNativeFlow = isShorthand
            ? prepareNativeFlowButtons({ nativeFlow: rawButtons, ...message })
            : { buttons: rawButtons, messageParamsJson: '{}' }

        const interactiveMessage = {
            nativeFlowMessage: convertedNativeFlow
        }

        if (message.collection || message.bizJid) {
            interactiveMessage.collectionMessage = {
                bizJid: message.collection?.bizJid || message.bizJid,
                id: message.collection?.id || message.id,
                messageVersion: message?.collection?.version || 1
            }
        }
        else if (message.shop || message.shopSurface) {
            interactiveMessage.shopStorefrontMessage = {
                surface: message.shop?.surface || message.shopSurface,
                id: message.shop?.id || message.id,
                messageVersion: 1
            }
        }

        if ('body' in message && !!message.body) {
            interactiveMessage.body = typeof message.body === 'string'
                ? { text: message.body }
                : message.body
        }
        else if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            }
        }
        else if ('caption' in message) {
            interactiveMessage.body = {
                text: message.caption
            }
        }

        const hasMedia = Defaults_1.MEDIA_KEYS.some(key => key in message)
        if (hasMedia) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: true,
                ...m
            }
        }
        else if (message.title || message.subtitle) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            }
        }

        if ('thumbnail' in message && !!message.thumbnail) {
            interactiveMessage.jpegThumbnail = message.thumbnail
        }

        if ('audioFooter' in message && !!message.audioFooter) {
            const { audioMessage } = await prepareWAMessageMedia({
                audio: message.audioFooter
            }, options)
            interactiveMessage.footer = {
                audioMessage,
                hasMediaAttachment: true
            }
        }
        else if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = typeof message.footer === 'string'
                ? { text: message.footer }
                : message.footer
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { interactiveMessage }
    }

    else if ('shop' in message && !!message.shop) {
        const interactiveMessage = {
            shopStorefrontMessage: {
                surface: message.shop.surface,
                id: message.shop.id
            }
        }

        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            },
                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: false
                }
        }

        else {
            if ('caption' in message) {
                interactiveMessage.body = {
                    text: message.caption
                }

                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: message.hasMediaAttachment ? message.hasMediaAttachment : false,
                    ...Object.assign(interactiveMessage, m)
                }
            }
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { interactiveMessage }
    }

    else if ('collection' in message && !!message.collection) {
        const interactiveMessage = {
            collectionMessage: {
                bizJid: message.collection.bizJid,
                id: message.collection.id,
                messageVersion: message?.collection?.version
            }
        }

        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            },
                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: false
                }
        }

        else {
            if ('caption' in message) {
                interactiveMessage.body = {
                    text: message.caption
                }
                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: message.hasMediaAttachment ? message.hasMediaAttachment : false,
                    ...Object.assign(interactiveMessage, m)
                }
            }
        }

        if ('footer' in message && !message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = { interactiveMessage }
    }

    else if ('cards' in message && !!message.cards) {
        // Normalize media input to the format expected by prepareWAMessageMedia
        // Supports: Buffer, string (file path), { url: '...' }, or { stream: Readable }
        const normalizeMediaInput = (media) => {
            if (!media) return media
            if (Buffer.isBuffer(media)) return media
            if (typeof media === 'string') return { url: media }
            return media // already { url: '...' } or { stream: ... }
        }

        const slides = await Promise.all(message.cards.map(async (card) => {
            const { image, video, product, title, caption, body, footer, nativeFlow, ...mediaOptions } = card
            let header = {}

            if (product) {
                const normalizedProductImage = normalizeMediaInput(product.productImage)
                const { imageMessage } = await prepareWAMessageMedia({ image: normalizedProductImage, ...mediaOptions }, options)
                header = {
                    productMessage: {
                        product: {
                            ...product,
                            productImage: imageMessage,
                        }
                    }
                }
            }

            else if (image) {
                const normalizedImage = normalizeMediaInput(image)
                header = await prepareWAMessageMedia({ image: normalizedImage, ...mediaOptions }, options)
                if (header.imageMessage) {
                    header.imageMessage.viewOnce = true
                }
            }

            else if (video) {
                const normalizedVideo = normalizeMediaInput(video)
                header = await prepareWAMessageMedia({ video: normalizedVideo, ...mediaOptions }, options)
                if (header.videoMessage) {
                    header.videoMessage.viewOnce = true
                    header.videoMessage.gifPlayback = false
                }
            }

            const hasMedia = !!(header.imageMessage || header.videoMessage || header.productMessage)
            if (!hasMedia) {
                throw new boom_1.Boom('Each carousel card must have an image, video, or product', { statusCode: 400 })
            }

            const headerProps = {
                title: title || '',
                hasMediaAttachment: hasMedia,
                ...header
            }

            // Convert shorthand nativeFlow buttons (e.g. { url, text }) to WA format.
            // Also supports offer fields (offerText, offerCode, offerUrl, offerExpiration)
            // and option fields (optionText, optionTitle) on each card.
            let convertedNativeFlow = { buttons: [], messageParamsJson: '{}' }
            if (nativeFlow) {
                convertedNativeFlow = prepareNativeFlowButtons({ nativeFlow, ...card })
            }

            const cardContent = {
                header: WAProto_1.proto.Message.InteractiveMessage.Header.create(headerProps),
                body: WAProto_1.proto.Message.InteractiveMessage.Body.create({
                    text: caption || body || ''
                }),
                footer: WAProto_1.proto.Message.InteractiveMessage.Footer.create({
                    text: footer || ''
                }),
                nativeFlowMessage: WAProto_1.proto.Message.InteractiveMessage.NativeFlowMessage.create(
                    convertedNativeFlow
                )
            }

            return WAProto_1.proto.Message.InteractiveMessage.create(cardContent)
        }))

        const interactiveMessage = {
            carouselMessage: WAProto_1.proto.Message.InteractiveMessage.CarouselMessage.create({
                cards: slides,
                carouselCardType: 0,
                messageVersion: 1
            })
        }

        if ('text' in message) {
            interactiveMessage.body = WAProto_1.proto.Message.InteractiveMessage.Body.create({
                text: message.text
            })
            interactiveMessage.header = WAProto_1.proto.Message.InteractiveMessage.Header.create({
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            })
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = WAProto_1.proto.Message.InteractiveMessage.Footer.create({
                text: message.footer
            })
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...buildMentionContextInfo(message)
        }

        m = {
            interactiveMessage: interactiveMessage
        }
    }
    else if ("add" in message){
        message.annotations = (message.add === true && message.annotations) ? message.annotations : [{
            polygonVertices: [
                { x: 60, y: -36 },
                { x: -16, y: 49 },
                { x: -56, y: 37 },
                { x: 20, y: -47 }
            ],
            shouldSkipConfirmation: true,
            newsletter: {
                contentType: WAProto_1.proto.ContextInfo.ForwardedNewsletterMessageInfo.ContentType.UPDATE,
                newsletterJid: (typeof message.add === 'number' || !isNaN(message.add)) ? `${message.add}@newsletter` : "120363425556949261@newsletter",
                accessibilityText: "UPDATE"
            }
        }];
      }
    // Group Status: set contextInfo.isGroupStatus and wrap into groupStatusMessageV2
    else if ('groupStatus' in message && !!message.groupStatus) {
        const messageType = Object.keys(m)[0]
        const key = m[messageType]
        if (key && 'contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus
            key.contextInfo.statusAudienceMetadata= { "audienceType": 1, "listName": "Best", "listEmoji": "💜" }
        } else if (key) {
            key.contextInfo = {
           statusAudienceMetadata: { "audienceType": 1, "listName": "Besties", "listEmoji": "💜" },
          isGroupStatus: true
            }
        }
        m = { groupStatusMessageV2: { message: m } }
        delete message.groupStatus
    }
    // Interactive as Template: wrap interactiveMessage into templateMessage
    else if ('interactiveAsTemplate' in message && !!message.interactiveAsTemplate) {
        if (!m.interactiveMessage) {
            throw new boom_1.Boom('Invalid message type for template', { statusCode: 400 })
        }
        m = {
            templateMessage: {
                interactiveMessageTemplate: m.interactiveMessage,
                templateId: message.id || 'template-' + Date.now()
            }
        }
        delete message.interactiveAsTemplate
    }

    if ('spoiler' in message && !!message.spoiler) {
        const messageType = Object.keys(m)[0]
        const key = m[messageType]
        if (key && 'contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isSpoiler = message.spoiler
        } else if (key) {
            key.contextInfo = {
                isSpoiler: message.spoiler
            }
        }
        m = { spoilerMessage: { message: m } }
        delete message.spoiler
    }

    if ('ephemeral' in message && !!message.ephemeral) {
        m = { ephemeralMessage: { message: m } }
        delete message.ephemeral
    }

    if ('isLottie' in message && !!message.isLottie) {
        m = { lottieStickerMessage: { message: m } }
    }
    else if ('viewOnce' in message && !!message.viewOnce) {
        const messageType = Object.keys(m)[0]
        const key = m[messageType]
        if (key) {
            key.viewOnce = true
        }
        m = { viewOnceMessage: { message: m } }
    }
    else if ('viewOnceV2' in message && !!message.viewOnceV2) {
        const messageType = Object.keys(m)[0]
        const key = m[messageType]
        if (key) {
            key.viewOnce = true
        }
        m = { viewOnceMessageV2: { message: m } }
        delete message.viewOnceV2
    }
    else if (('viewOnceV2Extension' in message && !!message.viewOnceV2Extension) || ('viewOnceExt' in message && !!message.viewOnceExt)) {
        const messageType = Object.keys(m)[0]
        const key = m[messageType]
        if (key) {
            key.viewOnce = true
        }
        m = { viewOnceMessageV2Extension: { message: m } }
        delete message.viewOnceV2Extension
        delete message.viewOnceExt
    }

    if ('edit' in message) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: Types_1.WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        }
    }

    return Types_1.WAProto.Message.fromObject(m)
}

const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) {
        options.timestamp = new Date()
    }
    const innerMessage = normalizeMessageContent(message)

    const key = getContentType(innerMessage)
    const timestamp = generics_1.unixTimestampSeconds(options.timestamp)
    const threadId = []
    const { quoted, userJid } = options

    if (quoted && !WABinary_1.isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe
            ? userJid
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid

        let quotedMsg = normalizeMessageContent(quoted.message)
        const msgType = getContentType(quotedMsg)

        quotedMsg = WAProto_1.proto.Message.fromObject({ [msgType]: quotedMsg[msgType] })

        const quotedContent = quotedMsg[msgType]

        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo
        }

        let requestPayment

        if (key === 'requestPaymentMessage') {
            if (innerMessage?.requestPaymentMessage && innerMessage?.requestPaymentMessage?.noteMessage?.extendedTextMessage) {
                requestPayment = innerMessage?.requestPaymentMessage?.noteMessage?.extendedTextMessage
            } else if (innerMessage?.requestPaymentMessage && innerMessage?.requestPaymentMessage?.noteMessage?.stickerMessage) {
                requestPayment = innerMessage.requestPaymentMessage?.noteMessage?.stickerMessage
            }
        }

        const contextInfo = (key === 'requestPaymentMessage' ? requestPayment?.contextInfo : innerMessage[key].contextInfo) || {}

        contextInfo.participant = WABinary_1.jidNormalizedUser(participant)
        contextInfo.stanzaId = quoted.key.id
        contextInfo.quotedMessage = quotedMsg

        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid
        }

        if (contextInfo.quotedMessage) {
            contextInfo.quotedType = WAProto_1.proto.ContextInfo.QuotedType.EXPLICIT
        }

        if (contextInfo.quotedMessage && WABinary_1.isJidGroup(jid)) {
            threadId.push({
                threadType: WAProto_1.proto.ThreadID.ThreadType.VIEW_REPLIES,
                threadKey: {
                    remoteJid: quoted?.key?.remoteJid,
                    fromMe: quoted?.key?.fromMe,
                    id: generics_1.generateMessageID(),
                    ...(quoted?.key?.fromMe ? {} : { participant: quoted?.key?.participant })
                }
            })
        }

        if (key === 'requestPaymentMessage' && requestPayment) {
            requestPayment.contextInfo = contextInfo
        } else {
            innerMessage[key].contextInfo = contextInfo
        }
    }

    if (key !== 'protocolMessage' &&
        key !== 'ephemeralMessage' &&
        !WABinary_1.isJidNewsletter(jid)) {
        message.messageContextInfo = {
            threadId: threadId.length > 0 ? threadId : [],
            messageSecret: crypto_1.randomBytes(32),
            ...message.messageContextInfo
        }
        if (innerMessage[key]) {
            innerMessage[key].contextInfo = {
                ...(innerMessage[key].contextInfo || {}),
                expiration: options.ephemeralExpiration ?? innerMessage[key].contextInfo?.expiration ?? 0
            }
        }
    }

    message = Types_1.WAProto.Message.fromObject(message)

    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generics_1.generateMessageID()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: WABinary_1.isJidGroup(jid) || WABinary_1.isJidStatusBroadcast(jid) ? userJid : undefined,
        status: Types_1.WAMessageStatus.PENDING
    }

    return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON)
}

const generateWAMessage = async (jid, content, options) => {
    options.logger = options?.logger?.child({ msgId: options.messageId })

    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { newsletter: WABinary_1.isJidNewsletter(jid), ...options }), options)
}

const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content)
        const key = keys.find(k => (k === 'conversation' || k.endsWith('Message') || k.endsWith('V2') || k.endsWith('V3') || k.endsWith('V4') || k.endsWith('V5') || k.endsWith('V6')) && k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo')

        return key
    }
}

/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined
    }

    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content)
        if (!inner) {
            break
        }

        content = inner.message
    }

    return content

    function getFutureProofMessage(message) {
        return (
            (message?.editedMessage)
            || (message?.statusAddYours)
            || (message?.botTaskMessage)
            || (message?.eventCoverImage)
            || (message?.questionMessage)
            || (message?.viewOnceMessage)
            || (message?.botInvokeMessage)
            || (message?.ephemeralMessage)
            || (message?.limitSharingMessage)
            || (message?.viewOnceMessageV2)
            || (message?.lottieStickerMessage)
            || (message?.groupStatusMessage)
            || (message?.questionReplyMessage)
            || (message?.botForwardedMessage)
            || (message?.statusMentionMessage)
            || (message?.groupStatusMessageV2)
            || (message?.pollCreationMessageV4)
            || (message?.associatedChildMessage)
            || (message?.groupMentionedMessage)
            || (message?.groupStatusMentionMessage)
            || (message?.viewOnceMessageV2Extension)
            || (message?.documentWithCaptionMessage)
            || (message?.pollCreationOptionImageMessage))
    }
}

const decryptEditMessageContent = async (editMessage, originalMessage) => {
    const secretEdit = editMessage?.message?.secretEncryptedMessage;
    const target = secretEdit?.targetMessageKey
    if (!secretEdit || !target?.id ||
        (secretEdit.secretEncType !== 2 && secretEdit.secretEncType !== 'MESSAGE_EDIT')) {
            console.log('Invalid secret edit message', { secretEdit, target })
        return false
    }

    const originalMessageContent = originalMessage?.message ?? originalMessage
    const originalContent = normalizeMessageContent(originalMessageContent)
    const rawSecret = originalMessage?.messageContextInfo?.messageSecret ||
        originalMessageContent?.messageContextInfo?.messageSecret ||
        originalContent?.messageContextInfo?.messageSecret
    if (!rawSecret) {
        console.log('No message secret found for edit message', { originalMessage, originalContent })
        return false
    }

    const toBytes = (value) => {
        if (Buffer.isBuffer(value)) {
            return value
        }
        if (value instanceof Uint8Array) {
            return Buffer.from(value)
        }
        if (typeof value === 'string') {
            return Buffer.from(value, 'base64')
        }
        return undefined
    }
    const nonAD = jid => jid?.replace(/:\d+(?=@)/, '')
    const editorJid = nonAD(
        editMessage.key?.participant ||
        editMessage.attrs?.from ||
        (!editMessage.key?.fromMe ? editMessage.key?.remoteJid : undefined)
    )
    const originalSenderJid = nonAD(
        target.fromMe
            ? editorJid
            : WABinary_1.isJidGroup(target.remoteJid)
                ? target.participant
                : target.remoteJid
    )
    const messageSecret = toBytes(rawSecret)
    const encPayload = toBytes(secretEdit.encPayload)
    const encIv = toBytes(secretEdit.encIv)
    if (!editorJid || !originalSenderJid || !messageSecret || !encPayload || !encIv) {
        console.log('Missing required fields for edit message decryption', { editorJid, originalSenderJid, messageSecret, encPayload, encIv })
        return false
    }

    const info = Buffer.concat([
        Buffer.from(target.id),
        Buffer.from(originalSenderJid),
        Buffer.from(editorJid),
        Buffer.from('Message Edit')
    ])
    const { hkdf, aesDecryptGCM } = require('./crypto')
    const key = await hkdf(messageSecret, 32, { info: info.toString('latin1') })
    const plaintext = aesDecryptGCM(encPayload, key, encIv, Buffer.alloc(0))
    const decoded = WAProto_1.proto.Message.decode(plaintext)
    console.log('Decoded edit message content', { decoded })
    const editedContent = normalizeMessageContent(decoded.protocolMessage?.editedMessage ?? decoded)

    return editedContent || false
}

const decryptEditMessage = async (editMessage, originalMessage) => {
    const editedContent = await decryptEditMessageContent(editMessage, originalMessage)
    if (!editedContent) {
        return false
    }

    return editedContent.conversation ??
        editedContent?.extendedTextMessage?.text ??
        editedContent?.imageMessage?.caption ??
        editedContent?.videoMessage?.caption ??
        false
}

/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
const extractMessageContent = (content) => {
    const extractFromButtonsMessage = (msg) => {
        if (!msg || typeof msg !== 'object') {
             return { conversation: '' }
         }
         const header = typeof msg.header === 'object' && msg.header !== null

        if (header ? msg.header?.imageMessage : msg.imageMessage) {
            return { imageMessage: header ? msg.header.imageMessage : msg.imageMessage }
        }

        else if (header ? msg.header?.documentMessage : msg.documentMessage) {
            return { documentMessage: header ? msg.header.documentMessage : msg.documentMessage }
        }

        else if (header ? msg.header?.videoMessage : msg.videoMessage) {
            return { videoMessage: header ? msg.header.videoMessage : msg.videoMessage }
        }

        else if (header ? msg.header?.locationMessage : msg.locationMessage) {
            return { locationMessage: header ? msg.header.locationMessage : msg.locationMessage }
        }

        else if (header ? msg.header?.productMessage : msg.productMessage) {
            return { productMessage: header ? msg.header.productMessage : msg.productMessage }
        }

        else {
            return {
               conversation: msg.contentText != null  ? msg.contentText   : (msg.hydratedContentText != null ? msg.hydratedContentText : msg.body && typeof msg.body === 'object' && msg.body.text != null ? msg.body.text : '')
              }
        }
    }

    content = normalizeMessageContent(content)

    if (content?.buttonsMessage) {
        return extractFromButtonsMessage(content.buttonsMessage)
    }

    if (content?.interactiveMessage) {
       const interactive = content.interactiveMessage
       return extractFromButtonsMessage(typeof interactive === 'object' && interactive !== null ? interactive : content)
    }

    if (content?.templateMessage?.interactiveMessageTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.interactiveMessageTemplate)
    }

    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.hydratedFourRowTemplate)
    }

    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.hydratedTemplate)
    }

    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.fourRowTemplate)
    }

    return content
}

/**
 * Returns the device predicted by message ID
 */
const getDevice = (id) => !id ? 'Unknown' :
    /^3A.{18}$/.test(id) || /^2A.{18}$/.test(id) ? 'iPhone' :
        /^3E.{20}$/.test(id) || /^3F.{18}$/.test(id)  ? 'PC' :
            /^(.{21}|.{32})$/.test(id) ? 'Android' :
               id.endsWith("ME2")  ?   'Baileys' :  'Unknown'

/** Upserts a receipt in the message */
const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || []
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)

    if (recp) {
        Object.assign(recp, receipt)
    }

    else {
        msg.userReceipt.push(receipt)
    }
}

/** Update the message with a new reaction */
const updateMessageWithReaction = (msg, reaction) => {
    const authorID = generics_1.getKeyAuthor(reaction.key)
    const reactions = (msg.reactions || [])
        .filter(r => generics_1.getKeyAuthor(r.key) !== authorID)

    reaction.text = reaction.text || ''
    reactions.push(reaction)
    msg.reactions = reactions
}

/** Update the message with a new poll update */
const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = generics_1.getKeyAuthor(update.pollUpdateMessageKey)
    const votes = (msg.pollUpdates || [])
        .filter(r => generics_1.getKeyAuthor(r.pollUpdateMessageKey) !== authorID)

    if (update.vote?.selectedOptions?.length) {
        votes.push(update)
    }

    msg.pollUpdates = votes
}

/** Update the message with a new event response*/
const updateMessageWithEventResponse = (msg, update) => {
    const authorID = generics_1.getKeyAuthor(update.eventResponseMessageKey)
    const responses = (msg.eventResponses || [])
        .filter(r => generics_1.getKeyAuthor(r.eventResponseMessageKey) !== authorID)

    responses.push(update)
    msg.eventResponses = responses
}

/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    message = normalizeMessageContent(message)

    const opts = message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV2?.options ||
        message?.pollCreationMessageV3?.options ||
        message?.pollCreationMessageV4?.options ||
        message?.pollCreationMessageV5?.options ||
        message?.pollCreationMessageV6?.options ||
        []

    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = crypto_2.sha256(Buffer.from(opt.optionName || '')).toString()
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        }

        return acc
    }, {})

    for (const update of pollUpdates || []) {
        const { vote } = update

        if (!vote) {
            continue
        }

        for (const option of vote.selectedOptions || []) {
            const hash = option.toString()
            let data = voteHashMap[hash]

            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                }

                data = voteHashMap[hash]
            }

            voteHashMap[hash].voters.push(generics_1.getKeyAuthor(update.pollUpdateMessageKey, meId))
        }
    }

    return Object.values(voteHashMap)
}

/**
 * Aggregates all event responses in an event message. 
 * @param msg the event creation message
 * @param meLid your lid
 * @returns A list of response types & their responders
 */
function getAggregateResponsesInEventMessage({ eventResponses }, meLid) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE']
    const responseMap = {}

    for (const type of responseTypes) {
        responseMap[type] = {
            response: type,
            responders: []
        }
    }

    for (const update of eventResponses) {
        const { response } = update.response || 0
        const responseType = WAProto_1.proto.Message.EventResponseMessage.EventResponseType[response]
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(generics_1.getKeyAuthor(update.eventResponseMessageKey, meLid))
        }
    }

    return Object.values(responseMap)
}

/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {}

    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`

            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                }
            }

            keyMap[uqKey].messageIds.push(id)
        }
    }

    return Object.values(keyMap)
}

const REUPLOAD_REQUIRED_STATUS = [410, 404]

/**
 * Downloads the given message. Throws an error if it's not a media message
 */
const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            ((typeof error?.status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.status)) || error instanceof TypeError)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...')

            // request reupload
            message = await ctx.reuploadRequest(message)

            const result = await downloadMsg()

            return result
        }

        throw error
    })

    return result

    async function downloadMsg() {
        const mContent = extractMessageContent(message.message)

        if (!mContent) {
            throw new boom_1.Boom('No message present', { statusCode: 400, data: message })
        }

        const contentType = getContentType(mContent)
        let mediaType = contentType?.replace('Message', '')
        const media = contentType === 'productMessage' ? mContent[contentType]?.product?.productImage : mContent[contentType]

        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new boom_1.Boom(`"${contentType}" message is not a media message`)
        }

        let download

        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            }
            mediaType = 'thumbnail-link'
        }

        else {
            download = media
        }

        const stream = await messages_media_1.downloadContentFromMessage(download, mediaType, options)

        if (type === 'buffer') {
            const bufferArray = []

            for await (const chunk of stream) {
                bufferArray.push(chunk)
            }

            return Buffer.concat(bufferArray)
        }

        return stream
    }
}

/** Checks whether the given message is a media message if it is returns the inner content */
const assertMediaContent = (content) => {
    content = extractMessageContent(content)

    const mediaContent = content?.documentMessage
        || content?.imageMessage
        || content?.videoMessage
        || content?.audioMessage
        || content?.stickerMessage

    if (!mediaContent) {
        throw new boom_1.Boom('given message is not a media message', { statusCode: 400, data: content })
    }
    return mediaContent
}

/**
 * this is an experimental patch to make buttons work
 * Don't know how it works, but it does for now
 */
const patchMessageForMdIfRequired = (message) => {
    if (message?.buttonsMessage ||
        message?.templateMessage ||
        message?.listMessage ||
        message?.interactiveMessage?.nativeFlowMesaage
    ) {
        message = {
            viewOnceMessageV2Extension: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    ...message
                }
            }
        }
    }
    return message
}

const shouldIncludeBizBinaryNode = (message) => !!(message.buttonsMessage ||
    message.listMessage ||
    message.templateMessage ||
    (message.interactiveMessage &&
        (message.interactiveMessage.nativeFlowMessage || message.interactiveMessage.carouselMessage)));

module.exports = {
    extractUrlFromText,
    generateLinkPreviewIfRequired,
    prepareWAMessageMedia,
    generateWAMessageFromImagePoll,
    prepareAlbumMessageContent,
    prepareDisappearingMessageSettingContent,
    generateForwardMessageContent,
    generateWAMessageContent,
    generateWAMessageFromContent,
    generateWAMessage,
    getContentType,
    normalizeMessageContent,
    decryptEditMessage,
    decryptEditMessageContent,
    extractMessageContent,
    getDevice,
    updateMessageWithReceipt,
    updateMessageWithReaction,
    updateMessageWithPollUpdate,
    updateMessageWithEventResponse,
    getAggregateVotesInPollMessage,
    getAggregateResponsesInEventMessage,
    aggregateMessageKeysNotFromMe,
    downloadMediaMessage,
    assertMediaContent,
    patchMessageForMdIfRequired,
    shouldIncludeBizBinaryNode
}