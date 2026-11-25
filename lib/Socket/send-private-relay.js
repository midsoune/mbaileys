'use strict'

/**
 * sendPrivateRelay — versão unificada (melhor de todas)
 *
 * Mensagens personalizadas por destinatário dentro de um grupo (SPR).
 * Cada participante decifra apenas o conteúdo endereçado a ele, embora
 * todos vejam uma única mensagem no grupo.
 *
 * Recursos combinados:
 *  - Caminho rápido (estilo Nixel): se TODOS os alvos recebem a MESMA
 *    mensagem, cifra uma vez com Sender Key e só distribui a chave
 *  - Caminho personalizado: mensagem diferente por jid → pairwise por pessoa
 *  - Batching automático por tamanho de frame + quantidade de devices
 *  - Retry com split de lote em caso de 479 / rate-limit
 *  - SKDM + skmsg de grupo feitos na mão (não depende de API interna instável)
 *  - Cifragem pairwise via sock.createParticipantNodes (API oficial)
 *  - Reporting token, device-identity, mediatype, expiration, decrypt-fail
 *  - Filtros: mode (include/exclude), target, targetMe, deviceMode
 *  - Alinhamento automático LID ↔ PN + ephemeral do grupo
 *  - hideFallback (evita texto genérico no iOS)
 *  - Compatível com vários forks do Baileys
 */

const crypto = require('crypto')
const { Boom } = require('@hapi/boom')

const log = typeof global.log !== 'undefined' ? global.log : console

const proto = require('../../WAProto').proto
const Utils = require('../Utils')
const { jidDecode, jidEncode } = require('../WABinary')
const {
  Curve,
  encodeWAMessage,
  encodeSignedDeviceIdentity,
  normalizeMessageContent,
  generateMessageID
} = Utils
const isHostedLidUser = jid => typeof jid === 'string' && jid.endsWith('@hosted.lid')
const isHostedPnUser = jid => typeof jid === 'string' && jid.endsWith('@hosted')

// ── constantes ───────────────────────────────────────────────────

const MAX_FRAME_BYTES = 0xffffff // 3 bytes de tamanho no frame do noise
const DEFAULT_FRAME_BUDGET = Math.floor(MAX_FRAME_BYTES * 0.75)
const DEVICE_OVERHEAD_BYTES = 512
const RETRYABLE_ERROR = /479|too many|rate.?overlimit|resource/i

// ── helpers de JID ───────────────────────────────────────────────

function stripDevice(jid) {
  if (!jid || typeof jid !== 'string') return jid
  const at = jid.indexOf('@')
  if (at < 0) return jid
  const user = jid.slice(0, at).split(':')[0]
  return user + jid.slice(at)
}

function normalizeUserJid(jid) {
  if (!jid) return null
  const s = String(jid).trim()
  if (!s.includes('@')) {
    const digits = s.replace(/\D/g, '')
    return digits ? `${digits}@s.whatsapp.net` : null
  }
  return stripDevice(s)
}

function isLid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid')
}

function isPn(jid) {
  return (
    typeof jid === 'string' &&
    (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'))
  )
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean))]
}

// ── primitivas de criptografia de grupo (Sender Key) ─────────────
// Implementadas diretamente — não dependem de signalRepository.encryptGroupMessage

function encodeVarint(value) {
  const bytes = []
  while (value >= 128) {
    bytes.push((value & 127) | 128)
    value >>>= 7
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

function generateSigningKeyPair() {
  const keys = Curve.generateKeyPair()
  const pubBuffer = Buffer.concat([
    Buffer.from([0x05]),
    Buffer.from(keys.public)
  ])
  return {
    privateKey: Buffer.from(keys.private),
    publicKey: pubBuffer
  }
}

function getMessageKey(chainSeed) {
  const messageKey = crypto
    .createHmac('sha256', chainSeed)
    .update(Buffer.from([0x01]))
    .digest()
  const salt = Buffer.alloc(32, 0)
  const info = Buffer.from('WhisperGroup')
  const prk = crypto.createHmac('sha256', salt).update(messageKey).digest()
  const t1 = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
  const t2 = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([t1, info, Buffer.from([0x02])]))
    .digest()
  const okm = Buffer.concat([t1, t2])
  return { iv: okm.slice(0, 16), cipherKey: okm.slice(16, 48) }
}

function encryptGroupMessage(plaintext, chainSeed, privateKeyObject, keyId) {
  const iteration = 0
  const { iv, cipherKey } = getMessageKey(chainSeed)
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ])
  const idBuf = Buffer.concat([Buffer.from([0x08]), encodeVarint(keyId)])
  const iterBuf = Buffer.concat([
    Buffer.from([0x10]),
    encodeVarint(iteration)
  ])
  const cipherBuf = Buffer.concat([
    Buffer.from([0x1a]),
    encodeVarint(ciphertext.length),
    ciphertext
  ])
  const messageProto = Buffer.concat([idBuf, iterBuf, cipherBuf])
  const messageToSign = Buffer.concat([Buffer.from([0x33]), messageProto])
  const signature = Curve.sign(privateKeyObject, messageToSign)
  return Buffer.concat([messageToSign, Buffer.from(signature)])
}

function createSKDM(keyId, iteration, chainSeed, signingPubKey) {
  const idBuf = Buffer.concat([Buffer.from([0x08]), encodeVarint(keyId)])
  const iterBuf = Buffer.concat([
    Buffer.from([0x10]),
    encodeVarint(iteration)
  ])
  const chainBuf = Buffer.concat([
    Buffer.from([0x1a]),
    encodeVarint(chainSeed.length),
    chainSeed
  ])
  const signBuf = Buffer.concat([
    Buffer.from([0x22]),
    encodeVarint(signingPubKey.length),
    signingPubKey
  ])
  const message = Buffer.concat([idBuf, iterBuf, chainBuf, signBuf])
  return Buffer.concat([Buffer.from([0x33]), message])
}

function deriveReportingTag(message, msgId, remoteJid) {
  if (!message.messageContextInfo) message.messageContextInfo = {}
  if (
    !Buffer.isBuffer(message.messageContextInfo.messageSecret) ||
    message.messageContextInfo.messageSecret.length !== 32
  ) {
    message.messageContextInfo.messageSecret = crypto.randomBytes(32)
  }
  const seed = message.messageContextInfo.messageSecret
  const payload = Buffer.from(proto.Message.encode(message).finish())
  const salt = Buffer.alloc(32, 0)
  const info = Buffer.concat([
    Buffer.from(msgId, 'utf8'),
    Buffer.from(remoteJid, 'utf8'),
    Buffer.from(remoteJid, 'utf8'),
    Buffer.from('Report Token', 'utf8')
  ])
  const prk = crypto.createHmac('sha256', salt).update(seed).digest()
  const t1 = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
  const mac = crypto.createHmac('sha256', t1).update(payload).digest()

  const iv = Buffer.from([0x7a, 0x3b, 0x91, 0xc4, 0x2e, 0x1f, 0xd0, 0x63])
  const vec = Buffer.from([
    0x29, 0x6b, 0xc3, 0x8a, 0x67, 0x47, 0x95, 0x2f, 0x2c, 0x0a
  ])
  const nonce = mac.subarray(0, 4)
  const stream = crypto.createHmac('sha256', iv).update(nonce).digest()

  const raw = Buffer.alloc(10)
  for (let i = 0; i < 10; i++) raw[i] = vec[i] ^ iv[i & 7]

  const sig = crypto
    .createHmac('sha256', iv)
    .update(Buffer.concat([nonce, raw]))
    .digest()
    .subarray(0, 2)
  const block = Buffer.concat([raw, sig])
  for (let i = 0; i < 12; i++) block[i] ^= stream[i]

  return Buffer.concat([nonce, block])
}

// ── tipo de mensagem / mídia ─────────────────────────────────────

function getMediaType(message) {
  if (message.imageMessage) return 'image'
  if (message.videoMessage)
    return message.videoMessage.gifPlayback ? 'gif' : 'video'
  if (message.audioMessage)
    return message.audioMessage.ptt ? 'ptt' : 'audio'
  if (message.contactMessage) return 'vcard'
  if (message.documentMessage) return 'document'
  if (message.contactsArrayMessage) return 'contact_array'
  if (message.liveLocationMessage) return 'livelocation'
  if (message.stickerMessage) return 'sticker'
  if (message.listMessage) return 'list'
  if (message.listResponseMessage) return 'list_response'
  if (message.buttonsResponseMessage) return 'buttons_response'
  if (message.orderMessage) return 'order'
  if (message.productMessage) return 'product'
  if (message.interactiveResponseMessage) return 'native_flow_response'
  if (message.groupInviteMessage) return 'url'
  return ''
}

function getMessageType(message) {
  const normalized = normalizeMessageContent(message)
  if (!normalized) return 'text'
  if (normalized.reactionMessage || normalized.encReactionMessage)
    return 'reaction'
  if (
    normalized.pollCreationMessage ||
    normalized.pollCreationMessageV2 ||
    normalized.pollCreationMessageV3 ||
    normalized.pollUpdateMessage
  )
    return 'poll'
  if (normalized.eventMessage) return 'event'
  if (getMediaType(normalized) !== '') return 'media'
  return 'text'
}

// ── normalização de alvos ────────────────────────────────────────

function normalizeTargets(targets, options = {}) {
  const arr = Array.isArray(targets) ? targets : [targets]
  return arr
    .map((item) => {
      if (typeof item === 'string') {
        return {
          jid: normalizeUserJid(item),
          message:
            options.message || {
              extendedTextMessage: {
                text: options.text || 'Mensagem privada',
                contextInfo: {
                  mentionedJid: unique(options.mentions || [])
                }
              }
            },
          mentions: options.mentions || []
        }
      }
      const jid = normalizeUserJid(item.jid)
      const mentions = unique(item.mentions || options.mentions || [])
      let message = item.message
      if (!message) {
        message = {
          extendedTextMessage: {
            text: item.text || options.text || 'Mensagem privada',
            contextInfo: { mentionedJid: mentions }
          }
        }
      }
      return { jid, message, mentions }
    })
    .filter((t) => t.jid)
}

// ── alinhamento ao addressingMode do grupo ───────────────────────

async function alignTargets(sock, groupJid, prepared, options) {
  let groupMeta
  try {
    groupMeta =
      options.useCachedGroupMetadata !== false &&
      typeof sock.cachedGroupMetadata === 'function'
        ? await sock.cachedGroupMetadata(groupJid)
        : undefined
    if (!groupMeta?.participants) {
      groupMeta = await sock.groupMetadata(groupJid)
    }
  } catch (err) {
    log.warn(
      `Não foi possível obter metadata de ${groupJid}: ${err?.message || err}`
    )
  }

  const addressingMode =
    options.addressingMode ||
    (groupMeta?.addressingMode === 'lid' ? 'lid' : 'pn')
  const ephemeralDuration =
    groupMeta?.ephemeralDuration > 0 ? groupMeta.ephemeralDuration : 0
  const suffix = addressingMode === 'lid' ? '@lid' : '@s.whatsapp.net'
  const mapping = sock.signalRepository?.lidMapping
  const aligned = []

  for (const target of prepared) {
    let jid = target.jid
    if (!jid.endsWith(suffix)) {
      try {
        if (addressingMode === 'lid' && isPn(jid) && mapping?.getLIDForPN) {
          const lid = await mapping.getLIDForPN(jid)
          if (lid) jid = normalizeUserJid(lid)
        } else if (
          addressingMode === 'pn' &&
          isLid(jid) &&
          mapping?.getPNForLID
        ) {
          const pn = await mapping.getPNForLID(jid)
          if (pn) jid = normalizeUserJid(pn)
        }
      } catch (err) {
        log.warn(
          `Falha ao mapear LID/PN de ${target.jid}: ${err?.message || err}`
        )
      }
    }
    if (!jid.endsWith(suffix)) {
      log.warn(
        `Destinatário ${target.jid} pode estar incompatível com addressingMode=${addressingMode}`
      )
    }
    aligned.push({ ...target, jid: normalizeUserJid(jid) })
  }

  return { aligned, addressingMode, ephemeralDuration, groupMeta }
}

// ── descoberta de devices ────────────────────────────────────────

async function resolveDevices(sock, userJids, ownJids) {
  const list = unique(userJids.map(normalizeUserJid))
  if (!list.length) return new Map()

  let devices = []
  if (typeof sock.getUSyncDevices === 'function') {
    devices = await sock.getUSyncDevices(list, true, false)
  } else {
    devices = list.map((jid) => ({
      user: jid.split('@')[0],
      device: 0,
      jid,
      wireJid: jid
    }))
  }

  const byUser = new Map()
  for (const d of devices) {
    const wire =
      d.wireJid ||
      d.jid ||
      (d.user
        ? `${d.user}${d.device ? ':' + d.device : ''}@${
            d.server ||
            (String(d.user).length > 15 ? 'lid' : 's.whatsapp.net')
          }`
        : null)
    if (!wire) continue
    if (ownJids.has(wire) || ownJids.has(stripDevice(wire))) continue
    if (isHostedLidUser?.(wire) || isHostedPnUser?.(wire)) continue
    if (jidDecode(wire)?.device === 99) continue

    const userKey = stripDevice(wire)
    if (!byUser.has(userKey)) byUser.set(userKey, [])
    byUser.get(userKey).push(wire)
  }

  for (const jid of list) {
    const key = stripDevice(jid)
    if (!byUser.has(key) || !byUser.get(key).length) {
      byUser.set(key, [key])
    }
  }

  return byUser
}

// ── filtros (include / exclude / targetMe / deviceMode) ──────────

async function processFilters(sock, list) {
  const rules = []
  if (!Array.isArray(list)) return rules

  const getLidForPn = async (pnJid) => {
    try {
      return await sock.signalRepository?.lidMapping?.getLIDForPN(pnJid)
    } catch {
      return null
    }
  }
  const getPnForLid = async (lidJid) => {
    try {
      return await sock.signalRepository?.lidMapping?.getPNForLID(lidJid)
    } catch {
      return null
    }
  }

  for (const item of list) {
    if (!item) continue
    const decoded = jidDecode(item)
    if (!decoded) continue

    const hasDevice = item.includes(':')
    const targetDevice = hasDevice
      ? decoded.device !== undefined
        ? decoded.device
        : 0
      : null

    rules.push({
      user: decoded.user,
      device: targetDevice,
      server: decoded.server
    })

    if (decoded.server === 's.whatsapp.net') {
      const lidJid = await getLidForPn(item)
      if (lidJid) {
        const lidDecoded = jidDecode(lidJid)
        if (lidDecoded) {
          rules.push({
            user: lidDecoded.user,
            device: targetDevice,
            server: lidDecoded.server
          })
        }
      }
    } else if (decoded.server === 'lid') {
      const pnJid = await getPnForLid(item)
      if (pnJid) {
        const pnDecoded = jidDecode(pnJid)
        if (pnDecoded) {
          rules.push({
            user: pnDecoded.user,
            device: targetDevice,
            server: pnDecoded.server
          })
        }
      }
    }
  }
  return rules
}

function isMatch(targetJid, rules) {
  const decoded = jidDecode(targetJid)
  if (!decoded) return false
  const targetDevice =
    decoded.device !== undefined ? decoded.device : 0

  for (const rule of rules) {
    if (rule.user === decoded.user) {
      if (rule.device === null) return true
      if (rule.device === targetDevice) return true
    }
  }
  return false
}

// ── planejamento de lotes ────────────────────────────────────────

function planBatches(aligned, devicesByUser, options) {
  if (!proto?.Message?.encode) {
    throw new Error('[SPR] proto.Message.encode indisponível neste baileys.')
  }

  const batchSize = Math.max(1, Number(options.batchSize) || 30)
  const budget = Math.min(
    Number(options.maxFrameBytes) || DEFAULT_FRAME_BUDGET,
    MAX_FRAME_BYTES
  )

  const sizeCache = new Map()
  const batches = []
  let current = []
  let currentBytes = 0

  for (const target of aligned) {
    let plainBytes = sizeCache.get(target.message)
    if (plainBytes === undefined) {
      plainBytes = proto.Message.encode(target.message).finish().length
      sizeCache.set(target.message, plainBytes)
    }

    const deviceCount = (
      devicesByUser.get(stripDevice(target.jid)) || [target.jid]
    ).length
    const cost = (plainBytes + DEVICE_OVERHEAD_BYTES) * deviceCount

    if (cost > MAX_FRAME_BYTES) {
      throw new Error(
        `[SPR] Payload grande demais: ${target.jid} (${deviceCount} device(s)) ` +
          `exigiria ~${cost} bytes numa única stanza (limite ${MAX_FRAME_BYTES}). ` +
          `Reduza o tamanho da mensagem.`
      )
    }

    if (
      current.length &&
      (current.length >= batchSize || currentBytes + cost > budget)
    ) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(target)
    currentBytes += cost
  }

  if (current.length) batches.push(current)
  return batches
}

// ── mensagem compartilhada? (mesmo objeto pra todos) ─────────────

function isSharedMessage(aligned) {
  if (!aligned.length) return false
  const first = aligned[0].message
  for (let i = 1; i < aligned.length; i++) {
    if (aligned[i].message !== first) return false
  }
  return true
}

// ── caminho rápido: 1 cifra + SKDM só pros alvos (estilo Nixel) ──

async function publishSharedMessage(sock, {
  groupJid,
  addressingMode,
  messageId,
  aligned,
  devicesByUser,
  sharedMessage,
  hideDecryptFail,
  ephemeralDuration,
  reportingToken,
  mode,
  parsedTargets,
  targetMe,
  deviceMode,
  meId,
  meLid
}) {
  const devicesOf = (target) =>
    devicesByUser.get(stripDevice(target.jid)) || [target.jid]

  const filteredDevicesOf = (target) => {
    const all = devicesOf(target)
    return all.filter((deviceJid) => {
      const isOwn =
        jidDecode(deviceJid)?.user === jidDecode(meId)?.user ||
        (meLid && jidDecode(deviceJid)?.user === jidDecode(meLid)?.user)

      let shouldSend = true
      if (mode === 'include') {
        shouldSend = isMatch(deviceJid, parsedTargets)
      } else if (mode === 'exclude') {
        shouldSend = !isMatch(deviceJid, parsedTargets)
      }

      if (isOwn && typeof targetMe === 'boolean') {
        shouldSend = targetMe
      }

      const dId = jidDecode(deviceJid)?.device ?? 0
      if (deviceMode === 'primary' && dId !== 0) shouldSend = false
      if (deviceMode === 'secondary' && dId === 0) shouldSend = false

      return shouldSend
    })
  }

  const senderKeyRecipients = unique(aligned.flatMap(filteredDevicesOf))
  if (!senderKeyRecipients.length) {
    return { recipientCount: 0, deviceCount: 0 }
  }

  if (typeof sock.assertSessions === 'function') {
    await sock.assertSessions(senderKeyRecipients, true)
  }

  const patched =
    typeof sock.patchMessageBeforeSending === 'function'
      ? await sock.patchMessageBeforeSending(sharedMessage)
      : sharedMessage
  if (Array.isArray(patched)) {
    throw new Boom('[SPR] Per-jid patching não é suportado em grupos')
  }

  // cifra a mensagem REAL uma única vez
  const chainSeed = crypto.randomBytes(32)
  const { privateKey: signingKey, publicKey: signingPubKey } =
    generateSigningKeyPair()
  const keyId = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff

  const skmsg = encryptGroupMessage(
    encodeWAMessage(patched),
    chainSeed,
    signingKey,
    keyId
  )
  const skdm = createSKDM(keyId, 0, chainSeed, signingPubKey)

  const extraAttrs = {}
  if (hideDecryptFail) extraAttrs['decrypt-fail'] = 'hide'
  const mediaType = getMediaType(patched)
  if (mediaType) extraAttrs['mediatype'] = mediaType

  // participants carregam SÓ a chave (SKDM) — payload minúsculo
  const senderKeyMsg = {
    senderKeyDistributionMessage: {
      groupId: groupJid,
      axolotlSenderKeyDistributionMessage: skdm
    }
  }

  const { nodes: participantNodes, shouldIncludeDeviceIdentity } =
    await sock.createParticipantNodes(
      senderKeyRecipients,
      senderKeyMsg,
      extraAttrs
    )

  if (!participantNodes.length) {
    return { recipientCount: 0, deviceCount: 0 }
  }

  const content = [
    { tag: 'participants', attrs: {}, content: participantNodes },
    {
      tag: 'enc',
      attrs: { v: '2', type: 'skmsg', ...extraAttrs },
      content: skmsg
    }
  ]

  if (shouldIncludeDeviceIdentity) {
    content.push({
      tag: 'device-identity',
      attrs: {},
      content: encodeSignedDeviceIdentity(sock.authState.creds.account, true)
    })
  }

  if (reportingToken) {
    content.push({
      tag: 'reporting',
      attrs: {},
      content: [
        {
          tag: 'reporting_token',
          attrs: { v: '2' },
          content: reportingToken
        }
      ]
    })
  }

  const attrs = {
    to: groupJid,
    id: messageId,
    type: getMessageType(patched),
    addressing_mode: addressingMode || 'pn'
  }
  if (ephemeralDuration > 0) {
    attrs.expiration = String(ephemeralDuration)
  }

  await sock.sendNode({ tag: 'message', attrs, content })

  return {
    recipientCount: aligned.length,
    deviceCount: participantNodes.length
  }
}

// ── montagem e envio de um lote (caminho personalizado) ──────────

async function publishBatch(sock, {
  groupJid,
  addressingMode,
  messageId,
  batch,
  devicesByUser,
  fallbackMessage,
  hideDecryptFail,
  ephemeralDuration,
  reportingToken,
  mode,
  parsedTargets,
  targetMe,
  deviceMode,
  meId,
  meLid
}) {
  const devicesOf = (target) =>
    devicesByUser.get(stripDevice(target.jid)) || [target.jid]

  // aplica filtros (include/exclude + deviceMode + targetMe)
  const filteredDevicesOf = (target) => {
    const all = devicesOf(target)
    return all.filter((deviceJid) => {
      const isOwn =
        (jidDecode(deviceJid)?.user === jidDecode(meId)?.user) ||
        (meLid &&
          jidDecode(deviceJid)?.user === jidDecode(meLid)?.user)

      let shouldSend = true
      if (mode === 'include') {
        shouldSend = isMatch(deviceJid, parsedTargets)
      } else if (mode === 'exclude') {
        shouldSend = !isMatch(deviceJid, parsedTargets)
      }

      if (isOwn && typeof targetMe === 'boolean') {
        shouldSend = targetMe
      }

      const dId = jidDecode(deviceJid)?.device ?? 0
      if (deviceMode === 'primary' && dId !== 0) shouldSend = false
      if (deviceMode === 'secondary' && dId === 0) shouldSend = false

      return shouldSend
    })
  }

  const allBatchDevices = unique(batch.flatMap(filteredDevicesOf))
  if (!allBatchDevices.length) {
    return { recipientCount: 0, deviceCount: 0 }
  }

  if (typeof sock.assertSessions === 'function') {
    await sock.assertSessions(allBatchDevices, true)
  }

  // camada de grupo
  const patchedFallback =
    typeof sock.patchMessageBeforeSending === 'function'
      ? await sock.patchMessageBeforeSending(fallbackMessage)
      : fallbackMessage
  if (Array.isArray(patchedFallback)) {
    throw new Boom('[SPR] Per-jid patching não é suportado em grupos')
  }

  const chainSeed = crypto.randomBytes(32)
  const { privateKey: signingKey, publicKey: signingPubKey } =
    generateSigningKeyPair()
  const keyId = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff

  const skmsg = encryptGroupMessage(
    encodeWAMessage(patchedFallback),
    chainSeed,
    signingKey,
    keyId
  )
  const skdm = createSKDM(keyId, 0, chainSeed, signingPubKey)
  const senderKeyDistributionMessage = {
    groupId: groupJid,
    axolotlSenderKeyDistributionMessage: skdm
  }

  const extraAttrs = {}
  if (hideDecryptFail) extraAttrs['decrypt-fail'] = 'hide'
  const mediaType = getMediaType(patchedFallback)
  if (mediaType) extraAttrs['mediatype'] = mediaType

  const participantNodes = []
  let shouldIncludeDeviceIdentity = false

  for (const target of batch) {
    const devices = filteredDevicesOf(target)
    if (!devices.length) continue

    const personal = {
      ...target.message,
      senderKeyDistributionMessage
    }

    const { nodes, shouldIncludeDeviceIdentity: needsIdentity } =
      await sock.createParticipantNodes(devices, personal, extraAttrs)

    participantNodes.push(...nodes)
    shouldIncludeDeviceIdentity =
      shouldIncludeDeviceIdentity || needsIdentity
  }

  if (!participantNodes.length) {
    return { recipientCount: 0, deviceCount: 0 }
  }

  const content = [
    { tag: 'participants', attrs: {}, content: participantNodes },
    {
      tag: 'enc',
      attrs: { v: '2', type: 'skmsg', ...extraAttrs },
      content: skmsg
    }
  ]

  if (shouldIncludeDeviceIdentity) {
    content.push({
      tag: 'device-identity',
      attrs: {},
      content: encodeSignedDeviceIdentity(
        sock.authState.creds.account,
        true
      )
    })
  }

  if (reportingToken) {
    content.push({
      tag: 'reporting',
      attrs: {},
      content: [
        {
          tag: 'reporting_token',
          attrs: { v: '2' },
          content: reportingToken
        }
      ]
    })
  }

  const attrs = {
    to: groupJid,
    id: messageId,
    type: getMessageType(patchedFallback),
    addressing_mode: addressingMode || 'pn'
  }
  if (ephemeralDuration > 0) {
    attrs.expiration = String(ephemeralDuration)
  }

  if (typeof sock.sendNode !== 'function') {
    throw new Error(
      '[SPR] sock.sendNode indisponível — versão do baileys incompatível.'
    )
  }

  await sock.sendNode({ tag: 'message', attrs, content })

  return {
    recipientCount: batch.length,
    deviceCount: participantNodes.length
  }
}

// ── núcleo do relay ──────────────────────────────────────────────

/**
 * Envia mensagens privadas num chat normal ou como relay dentro de um grupo.
 *
 * @param {object} sock - socket baileys autenticado
 * @param {string} chatJid - chat privado ou grupo @g.us
 * @param {Array|string|object} targets - alvos do grupo ou conteúdo do chat privado
 * @param {object} [options]
 * @param {string} [options.text]
 * @param {object} [options.message]
 * @param {string[]} [options.mentions]
 * @param {boolean} [options.hideFallback=true]
 * @param {string} [options.fallbackText]
 * @param {string} [options.messageId]
 * @param {number} [options.batchSize=30]
 * @param {number} [options.maxFrameBytes]
 * @param {number} [options.batchDelayMs=300]
 * @param {boolean} [options.hideDecryptFail=true]
 * @param {boolean} [options.useCachedGroupMetadata=true]
 * @param {'lid'|'pn'} [options.addressingMode]
 * @param {'include'|'exclude'} [options.mode='exclude']
 * @param {string[]} [options.target=[]] - JIDs usados nos filtros
 * @param {boolean} [options.targetMe]
 * @param {'all'|'primary'|'secondary'} [options.deviceMode='all']
 * @param {string} [options.deviceJid] - exact linked-device JID for a private chat
 * @param {(sent:number, total:number)=>any} [options.onProgress]
 * @returns {Promise<{ messageId, addressingMode, recipientCount, deviceCount, batches }>}
 */
async function sendPrivateRelay(sock, groupJid, targets, options = {}) {
  if (!sock?.user?.id) throw new Error('[SPR] Socket não autenticado')
  if (!groupJid) throw new Error('[SPR] Chat JID inválido')

  if (!String(groupJid).endsWith('@g.us')) {
    if (typeof sock.sendMessage !== 'function') {
      throw new Error('[SPR] sock.sendMessage indisponível nesta versão do baileys.')
    }

    const chatJid = normalizeUserJid(groupJid)
    if (!chatJid) throw new Error('[SPR] Chat JID inválido')

    let content = targets
    if (typeof content === 'string') content = { text: content }
    if (!content && options.message) content = options.message
    if (!content && options.text) content = { text: options.text }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error(
        '[SPR] Para chat privado, passe o conteúdo como segundo argumento: sock.sendPrivateRelay(jid, { text })'
      )
    }

    const deviceMode = options.deviceMode || 'all'
    if (!['all', 'primary', 'secondary'].includes(deviceMode)) {
      throw new Error('[SPR] deviceMode deve ser all, primary ou secondary')
    }

    const sendOptions = options.sendMessageOptions || {}
    if (options.deviceJid) {
      const requestedDevice = String(options.deviceJid)
      const device = jidDecode(requestedDevice)
      if (!device || device.device === undefined) {
        throw new Error('[SPR] deviceJid deve incluir um ID de dispositivo, ex.: user:2@s.whatsapp.net')
      }
      if (typeof sock.getUSyncDevices !== 'function') {
        throw new Error('[SPR] sock.getUSyncDevices indisponível para verificar deviceJid')
      }
      const devices = await sock.getUSyncDevices([chatJid], false, false)
      const available = devices.some(
        entry => (entry.wireJid || entry.jid) === requestedDevice
      )
      if (!available) {
        throw new Error(`[SPR] deviceJid ${requestedDevice} não pertence aos dispositivos encontrados para ${chatJid}`)
      }
      return sock.sendMessage(chatJid, content, {
        ...sendOptions,
        deviceJid: requestedDevice
      })
    }

    if (deviceMode === 'all') {
      return sock.sendMessage(chatJid, content, sendOptions)
    }
    if (typeof sock.getUSyncDevices !== 'function') {
      throw new Error('[SPR] sock.getUSyncDevices indisponível para filtrar dispositivos')
    }

    const devices = await sock.getUSyncDevices([chatJid], false, false)
    const selected = devices.filter(entry => {
      const deviceJid = entry.wireJid || entry.jid
      const deviceId = deviceJid ? jidDecode(deviceJid)?.device : entry.device
      return deviceMode === 'primary' ? (deviceId || 0) === 0 : (deviceId || 0) !== 0
    })
    if (!selected.length) {
      throw new Error(`[SPR] Nenhum dispositivo ${deviceMode} encontrado para ${chatJid}`)
    }

    const results = []
    for (const entry of selected) {
      const deviceJid = entry.wireJid || entry.jid
      if (!deviceJid) {
        throw new Error('[SPR] Resultado de getUSyncDevices sem JID de dispositivo')
      }
      results.push(await sock.sendMessage(chatJid, content, {
        ...sendOptions,
        deviceJid
      }))
    }
    return { deviceMode, devices: selected.length, messages: results }
  }
  if (typeof sock.createParticipantNodes !== 'function') {
    throw new Error(
      '[SPR] sock.createParticipantNodes indisponível nesta versão do baileys.'
    )
  }
  if (typeof sock.sendNode !== 'function') {
    throw new Error(
      '[SPR] sock.sendNode indisponível nesta versão do baileys.'
    )
  }

  const prepared = normalizeTargets(targets, options)
  if (!prepared.length) throw new Error('[SPR] Nenhum destinatário válido')

  const { aligned, addressingMode, ephemeralDuration } =
    await alignTargets(sock, groupJid, prepared, options)

  const meId = sock.user.id
  const meLid = sock.user.lid
  const ownJids = new Set()
  for (const own of [meId, meLid]) {
    if (!own) continue
    ownJids.add(own)
    ownJids.add(stripDevice(own))
  }

  const devicesByUser = await resolveDevices(
    sock,
    aligned.map((t) => t.jid),
    ownJids
  )

  const hideDecryptFail = options.hideDecryptFail !== false
  const mode = options.mode === 'include' ? 'include' : 'exclude'
  const parsedTargets = await processFilters(sock, options.target || [])
  const targetMe = options.targetMe
  const deviceMode = options.deviceMode || 'all'
  const messageId = options.messageId || generateMessageID(meId)

  // ── caminho rápido: mesma mensagem pra todos ───────────────────
  if (isSharedMessage(aligned)) {
    const sharedMessage = aligned[0].message
    const reportingToken = deriveReportingTag(
      sharedMessage,
      messageId,
      groupJid
    )

    const sent = await publishSharedMessage(sock, {
      groupJid,
      addressingMode,
      messageId,
      aligned,
      devicesByUser,
      sharedMessage,
      hideDecryptFail,
      ephemeralDuration,
      reportingToken,
      mode,
      parsedTargets,
      targetMe,
      deviceMode,
      meId,
      meLid
    })

    if (typeof options.onProgress === 'function') {
      await options.onProgress(sent.recipientCount, aligned.length)
    }

    return {
      messageId,
      addressingMode,
      recipientCount: sent.recipientCount,
      deviceCount: sent.deviceCount,
      batches: 1,
      path: 'shared'
    }
  }

  // ── caminho personalizado: mensagem diferente por pessoa ───────
  const batches = planBatches(aligned, devicesByUser, options)

  const fallbackMessage =
    options.hideFallback !== false
      ? {}
      : { conversation: options.fallbackText || 'Mensagem privada' }

  const reportingToken = deriveReportingTag(
    fallbackMessage,
    messageId,
    groupJid
  )
  const batchDelayMs = Number.isFinite(options.batchDelayMs)
    ? options.batchDelayMs
    : 300

  const totals = { recipientCount: 0, deviceCount: 0, batches: 0 }

  const sendBatch = async (batch) => {
    try {
      const sent = await publishBatch(sock, {
        groupJid,
        addressingMode,
        messageId,
        batch,
        devicesByUser,
        fallbackMessage,
        hideDecryptFail,
        ephemeralDuration,
        reportingToken,
        mode,
        parsedTargets,
        targetMe,
        deviceMode,
        meId,
        meLid
      })
      totals.recipientCount += sent.recipientCount
      totals.deviceCount += sent.deviceCount
      totals.batches += 1
    } catch (err) {
      if (
        batch.length <= 1 ||
        !RETRYABLE_ERROR.test(String(err?.message || err))
      ) {
        throw err
      }
      log.warn(
        `Lote rejeitado (${batch.length} destinatários), dividindo e tentando novamente: ${err.message}`
      )
      const mid = Math.ceil(batch.length / 2)
      await sendBatch(batch.slice(0, mid))
      await sendBatch(batch.slice(mid))
    }
  }

  for (let i = 0; i < batches.length; i++) {
    await sendBatch(batches[i])
    if (typeof options.onProgress === 'function') {
      await options.onProgress(totals.recipientCount, aligned.length)
    }
    if (batchDelayMs > 0 && i < batches.length - 1) {
      await new Promise((r) => setTimeout(r, batchDelayMs))
    }
  }

  return { messageId, addressingMode, ...totals, path: 'personalized' }
}

// exports de compatibilidade
module.exports = {
  sendPrivateRelay,
  // utilitários caso precise
  normalizeUserJid,
  stripDevice
}