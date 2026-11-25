"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const Types_1 = require("../Types")
const Utils_1 = require("../Utils")
const WABinary_1 = require("../WABinary")
const groups_1 = require("./groups")
const mex_1 = require("./mex")
const WAProto_1 = require("../../WAProto")

const parseNewsletterMetadata = (metadata) => {
    if (metadata?.result && typeof metadata.result === 'object') {
        metadata = metadata.result
    }
    if (!metadata || typeof metadata.id !== 'string') {
        throw new Error('newsletter: MEX response does not contain newsletter metadata')
    }

    const thread = metadata.thread_metadata || {}
    const viewer = metadata.viewer_metadata || {}
    const timestamp = (value) => Number.parseInt(value ?? '0', 10)

    return {
        id: metadata.id,
        state: metadata.state?.type || metadata.state,
        creation_time: timestamp(thread.creation_time),
        name: thread.name?.text || thread.name || '',
        nameTime: timestamp(thread.name?.update_time),
        description: thread.description?.text || thread.description || '',
        descriptionTime: timestamp(thread.description?.update_time),
        invite: thread.invite || '',
        handle: thread.handle || null,
        picture: Utils_1.getUrlFromDirectPath(thread.picture?.direct_path || ''),
        preview: Utils_1.getUrlFromDirectPath(thread.preview?.direct_path || ''),
        reaction_codes: thread.settings?.reaction_codes?.value,
        subscribers: timestamp(thread.subscribers_count),
        verification: thread.verification,
        viewer_metadata: {
            mute: viewer.mute || 'UNDEFINED',
            view_role: viewer.view_role || viewer.role || 'GUEST'
        }
    }
}

const makeNewsletterSocket = (config) => {
    const sock = groups_1.makeGroupsSocket(config)
    const { query, generateMessageTag } = sock
    const executeWMexQuery = (variables, queryId, dataPath) =>
        mex_1.executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

    const newsletterQuery = (jid, type, content) => query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type,
            xmlns: 'newsletter',
            to: jid
        },
        content
    })

    const newsletterWMexQuery = (jid, queryId, content = {}) => query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            xmlns: 'w:mex',
            to: WABinary_1.S_WHATSAPP_NET
        },
        content: [{
            tag: 'query',
            attrs: { query_id: queryId },
            content: Buffer.from(JSON.stringify({
                variables: { newsletter_id: jid, ...content }
            }), 'utf-8')
        }]
    })

    const newsletterUpdate = (jid, updates) =>
        executeWMexQuery(
            { newsletter_id: jid, updates: { ...updates, settings: updates.settings ?? null } },
            Types_1.QueryIds.UPDATE_METADATA,
            'xwa2_newsletter_update'
        )

    const newsletterMetadata = async (type, key, role) => {
        const metadata = await executeWMexQuery({
            fetch_creation_time: true,
            fetch_full_image: true,
            fetch_viewer_metadata: true,
            input: {
                key,
                type: type.toUpperCase(),
                view_role: role || 'GUEST'
            }
        }, Types_1.QueryIds.METADATA, Types_1.XWAPaths.xwa2_newsletter_metadata)
        return parseNewsletterMetadata(metadata)
    }

    const parseFetchedUpdates = async (node, type) => {
        const parent = type === 'messages'
            ? node
            : WABinary_1.getBinaryNodeChild(node, 'message_updates')
        const messages = WABinary_1.getBinaryNodeChild(parent, 'messages')
        const messageNodes = WABinary_1.getAllBinaryNodeChildren(messages)

        return Promise.all(messageNodes.map(async (messageNode) => {
            messageNode.attrs.from = messages?.attrs?.jid
            const views = Number.parseInt(
                WABinary_1.getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0',
                10
            )
            const reactionNode = WABinary_1.getBinaryNodeChild(messageNode, 'reactions')
            const reactions = WABinary_1.getBinaryNodeChildren(reactionNode, 'reaction')
                .map(({ attrs }) => ({ count: Number(attrs.count), code: attrs.code }))
            const update = { server_id: messageNode.attrs.server_id, views, reactions }

            if (type === 'messages') {
                const { fullMessage, decrypt } = await Utils_1.decryptMessageNode(
                    messageNode,
                    sock.authState.creds.me.id,
                    sock.authState.creds.me.lid || '',
                    sock.signalRepository,
                    config.logger
                )
                await decrypt()
                update.message = fullMessage
            }

            return update
        }))
    }
// 2. toNewsletterUserSettingInput
 const toNewsletterUserSettingInput = (jid, type, muted) => {
    if (typeof jid !== 'string' || !jid.endsWith('@newsletter')) {
        throw new TypeError(`${JSON.stringify(jid)} is not a newsletter jid`);
    }
    return {
        input: {
            newsletter_id: jid,
            type: type === 'FOLLOWER_NOTIFICATIONS' ? 'MUTE_FOLLOWER_ACTIVITY' : 'MUTE_ADMIN_ACTIVITY',
            value: muted ? 'ON' : 'OFF'
        }
    };
};

// 3. parseNewsletterCreateResponse
const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture?.id,
            directPath: thread.picture?.direct_path
        },
        mute_state: viewer.mute
    };
};

// 4. decodeNewsletterPlaintext
const decodeNewsletterPlaintext = (plaintextNode) => {
    if (!plaintextNode?.content) {
        return undefined;
    }
    const buffer = typeof plaintextNode.content === 'string'
        ? Buffer.from(plaintextNode.content, 'binary')
        : Buffer.from(plaintextNode.content);
    return WAProto_1.proto.Message.decode(buffer).toJSON();
};

// 5. decodeNewsletterMessageNodes
const decodeNewsletterMessageNodes = (parentNode, newsletterJid, logger) => {
    const messages = [];
    for (const child of WABinary_1.getBinaryNodeChildren(parentNode, 'message')) {
        const plaintextNode = WABinary_1.getBinaryNodeChild(child, 'plaintext');
        if (!plaintextNode?.content) {
            continue;
        }
        try {
            const fullMessage = WAProto_1.proto.WebMessageInfo.fromObject({
                key: {
                    remoteJid: newsletterJid,
                    id: child.attrs.id || child.attrs.server_id,
                    fromMe: child.attrs.is_sender === 'true'
                },
                message: decodeNewsletterPlaintext(plaintextNode),
                messageTimestamp: child.attrs.t ? +child.attrs.t : undefined
            }).toJSON();
            if (child.attrs.server_id) {
                fullMessage.key.server_id = child.attrs.server_id;
            }
            const meta = extractNewsletterMessageMeta(child);
            if (meta) {
                fullMessage.newsletterMeta = meta;
                if (meta.adminProfile?.name) {
                    fullMessage.pushName = meta.adminProfile.name;
                }
            }
            messages.push(fullMessage);
        }
        catch (error) {
            logger?.error?.({ error }, 'Failed to decode newsletter message');
        }
    }
    return messages;
};

// 6. fetchMyAddOns
const fetchMyAddOns = async (options, type) => {
    const attrs = { limit: String(options.limit ?? 100) };
    if (type) {
        attrs.type = type;
    }
    if (options.jid) {
        attrs.jid = options.jid;
    }
    const result = await query({
        tag: 'iq',
        attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: WABinary_1.S_WHATSAPP_NET },
        content: [{ tag: 'my_addons', attrs, content: undefined }]
    });
    const addOns = WABinary_1.getBinaryNodeChild(result, 'my_addons');
    if (!addOns) {
        return [];
    }
    return WABinary_1.getBinaryNodeChildren(addOns, 'messages').map((group) => ({
        jid: group.attrs?.jid,
        messages: WABinary_1.getBinaryNodeChildren(group, 'message').map((entry) => {
            const reaction = WABinary_1.getBinaryNodeChild(entry, 'reaction');
            const votes = WABinary_1.getBinaryNodeChild(entry, 'votes');
            return {
                serverId: entry.attrs?.server_id ? Number(entry.attrs.server_id) : undefined,
                reaction: reaction
                    ? { code: reaction.attrs?.code, t: reaction.attrs?.t ? Number(reaction.attrs.t) : undefined }
                    : undefined,
                pollVote: votes
                    ? {
                        t: votes.attrs?.t ? Number(votes.attrs.t) : undefined,
                        hashes: WABinary_1.getBinaryNodeChildren(votes, 'vote').map(vote => Buffer.from(vote.content ?? []).toString('hex'))
                    }
                    : undefined
            };
        })
    }));
};

// 7. newsletterUserSetting
const newsletterUserSetting = async (jid, type, muted) => {
    const response = await executeWMexQuery(toNewsletterUserSettingInput(jid, type, muted), Types_1.QueryIds.UPDATE_USER_SETTING, Types_1.XWAPaths.xwa2_newsletter_update_user_setting);
    return {
        id: response?.id ?? jid,
        state: response?.state?.type
    };
};
    return {
        ...sock,
        newsletterQuery,
        newsletterWMexQuery,
        newsletterCreate: async (name, description, picture) => {
            await query({
                tag: 'iq',
                attrs: {
                    to: WABinary_1.S_WHATSAPP_NET,
                    xmlns: 'tos',
                    id: generateMessageTag(),
                    type: 'set'
                },
                content: [{
                    tag: 'notice',
                    attrs: { id: '20601218', stage: '5' },
                    content: []
                }]
            })

            const metadata = await executeWMexQuery({
                input: {
                    name,
                    description: description ?? null,
                    picture: picture
                        ? (await Utils_1.generateProfilePicture(picture)).img.toString('base64')
                        : null,
                    settings: { reaction_codes: { value: 'ALL' } }
                }
            }, Types_1.QueryIds.CREATE, Types_1.XWAPaths.xwa2_newsletter_create)
            return parseNewsletterMetadata(metadata)
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            const result = await newsletterWMexQuery(undefined, Types_1.QueryIds.SUBSCRIBERS, {
                newsletter_id: jid
            })
            const child = WABinary_1.getBinaryNodeChild(result, 'result')
            if (!child?.content) {
                throw new Error('newsletter subscribers: response has no result payload')
            }

            const payload = JSON.parse(child.content.toString())
            if (Array.isArray(payload.errors) && payload.errors.length) {
                throw new Error(payload.errors.map(error => error.message || 'Unknown error').join(', '))
            }

            const data = payload.data
            const expected = data?.[Types_1.XWAPaths.xwa2_newsletter_subscribers]
            const countOf = (value, traverseAll = false) => {
                if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
                if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
                if (!value || typeof value !== 'object') return undefined

                for (const [key, count] of Object.entries(value)) {
                    if (![
                        'subscribers', 'subscribers_count', 'subscriberscount',
                        'subscriber_count', 'subscribercount', 'count',
                        'total', 'total_count', 'totalcount', 'count_value', 'countvalue'
                    ].includes(key.toLowerCase().replace(/[-\s]/g, '_').replace(/_/g, ''))) continue
                    if (typeof count === 'number' && Number.isFinite(count)) return count
                    if (typeof count === 'string' && /^\d+$/.test(count)) return Number(count)
                }

                for (const [key, nested] of Object.entries(value)) {
                    if (nested && typeof nested === 'object' &&
                        (traverseAll || /subscriber|newsletter|result|data/i.test(key))) {
                        const count = countOf(nested, traverseAll)
                        if (count !== undefined) return count
                    }
                }
                return undefined
            }
            const subscribers = countOf(expected) ?? countOf(data)
            if (subscribers === undefined) {
                try {
                    const metadata = await newsletterMetadata('jid', jid, 'OWNER')
                    if (Number.isFinite(metadata.subscribers) && metadata.subscribers >= 0) {
                        return { subscribers: metadata.subscribers }
                    }
                } catch (error) {
                    throw new Error(
                        `newsletter subscribers: response does not contain a subscriber count; metadata fallback failed: ${error.message}`,
                        { cause: error }
                    )
                }
                throw new Error('newsletter subscribers: response does not contain a subscriber count')
            }
            return { subscribers }
        },
        newsletterMetadata,
        newsletterFollow: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.FOLLOW,
                Types_1.XWAPaths.xwa2_newsletter_join_v2
            ),
        newsletterUnfollow: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.UNFOLLOW,
                Types_1.XWAPaths.xwa2_newsletter_leave_v2
            ),
        newsletterMute: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.MUTE,
                Types_1.XWAPaths.xwa2_newsletter_mute_v2
            ),
        newsletterUnmute: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.UNMUTE,
                Types_1.XWAPaths.xwa2_newsletter_unmute_v2
            ),
        newsletterReactionMode: (jid, mode) =>
            newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } }),
        newsletterUpdateName: (jid, name) => newsletterUpdate(jid, { name }),
        newsletterUpdateDescription: (jid, description) =>
            newsletterUpdate(jid, { description: description || '' }),
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await Utils_1.generateProfilePicture(content)
            await newsletterUpdate(jid, { picture: img.toString('base64') })
            return newsletterMetadata('jid', jid, 'OWNER')
        },
        newsletterRemovePicture: (jid) => newsletterUpdate(jid, { picture: '' }),
        newsletterAction: async (jid, action) => {
            const queryId = Types_1.QueryIds[action.toUpperCase()]
            if (!queryId) throw new Error(`newsletter: unsupported action '${action}'`)
            return executeWMexQuery({ newsletter_id: jid }, queryId)
        },
        newsletterFetchAllParticipating: async () => {
            const newsletters = await executeWMexQuery(
                {},
                Types_1.QueryIds.SUBSCRIBED,
                Types_1.XWAPaths.SUBSCRIBED
            )
            if (!Array.isArray(newsletters)) {
                throw new Error('newsletter: subscribed MEX response does not contain a newsletter list')
            }

            const participating = {}
            for (const { id } of newsletters) {
                if (!WABinary_1.isJidNewsletter(id)) continue
                const metadata = await newsletterMetadata('jid', id)
                participating[metadata.id] = metadata
            }
            return participating
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.ADMIN_COUNT,
                Types_1.XWAPaths.xwa2_newsletter_admin_count
            )
            return response.admin_count
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery(
                { newsletter_id: jid, user_id: newOwnerJid },
                Types_1.QueryIds.CHANGE_OWNER,
                Types_1.XWAPaths.xwa2_newsletter_change_owner
            )
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery(
                { newsletter_id: jid, user_id: userJid },
                Types_1.QueryIds.DEMOTE,
                Types_1.XWAPaths.xwa2_newsletter_demote
            )
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.DELETE,
                Types_1.XWAPaths.xwa2_newsletter_delete_v2
            )
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }]
            })
        },
        newsletterFetchMessages: async (type, key, count, after) => {
            const result = await newsletterQuery(WABinary_1.S_WHATSAPP_NET, 'get', [{
                tag: 'messages',
                attrs: {
                    type,
                    ...(type === 'invite' ? { key } : { jid: key }),
                    count: count.toString(),
                    after: after?.toString() || '100'
                }
            }])
            return parseFetchedUpdates(result, 'messages')
        },
        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [{
                tag: 'message_updates',
                attrs: {
                    count: count.toString(),
                    after: after?.toString() || '100',
                    since: since?.toString() || '0'
                }
            }])
            return parseFetchedUpdates(result, 'updates')
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await newsletterQuery(jid, 'set', [{
                tag: 'live_updates',
                attrs: {},
                content: []
            }])
            const attrs = WABinary_1.getBinaryNodeChild(result, 'live_updates')?.attrs
            return attrs?.duration ? { duration: attrs.duration } : null
        },
        // yyyyyy
newsletterSubscribed: async (options = {}) => {
    return executeWMexQuery({
        fetch_status_metadata: options.fetchStatusMetadata === true,
        fetch_wamo_sub: options.fetchWamoSub === true
    }, Types_1.QueryIds.SUBSCRIBED, Types_1.XWAPaths.xwa2_newsletter_subscribed);
},

// 9. newsletterUpdateUserSetting
newsletterUpdateUserSetting: (jid, type, value) => newsletterUserSetting(jid, type, value),

// 10. newsletterFetchMessageUpdates
newsletterFetchMessageUpdates: async (jid, options = {}) => { // not work
    const { count = 20, since, before, after } = options;
    const attrs = { count: String(count) };
    if (since !== undefined) {
        attrs.since = String(since);
    }
    if (before !== undefined) {
        attrs.before = String(before);
    }
    else if (after !== undefined) {
        attrs.after = String(after);
    }
    const result = await query({
        tag: 'iq',
        attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid },
        content: [{ tag: 'message_updates', attrs, content: undefined }]
    });
    const updates = WABinary_1.getBinaryNodeChild(result, 'message_updates');
    const messages = updates && WABinary_1.getBinaryNodeChild(updates, 'messages');
    return {
        jid: messages?.attrs?.jid ?? jid,
        messages: messages ? decodeNewsletterMessageNodes(messages, messages.attrs?.jid ?? jid) : []
    };
},

// 11. newsletterQuestionResponses
newsletterQuestionResponses: async (jid, serverId, options = {}) => {
    const { count = 20, before, filter, searchText } = options;
    const attrs = { server_id: String(serverId), count: String(count) };
    if (before !== undefined) {
        attrs.before = String(before);
    }
    const content = [];
    if (filter) {
        content.push({ tag: 'filters', attrs: {}, content: [{ tag: filter, attrs: {}, content: undefined }] });
    }
    if (searchText) {
        content.push({ tag: 'search', attrs: { text: searchText }, content: undefined });
    }
    const result = await query({
        tag: 'iq',
        attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid },
        content: [{ tag: 'question_responses', attrs, content: content.length ? content : undefined }]
    });
    const responses = WABinary_1.getBinaryNodeChild(result, 'question_responses');
    if (!responses) {
        return { jid, serverId: Number(serverId), responses: [] };
    }
    return {
        jid: result.attrs?.from ?? jid,
        serverId: responses.attrs?.server_id ? Number(responses.attrs.server_id) : Number(serverId),
        responses: WABinary_1.getBinaryNodeChildren(responses, 'question_response').map((entry) => {
            const messageNode = WABinary_1.getBinaryNodeChild(entry, 'message');
            const sender = WABinary_1.getBinaryNodeChild(entry, 'sender');
            const picture = sender && WABinary_1.getBinaryNodeChild(sender, 'picture');
            const flags = WABinary_1.getBinaryNodeChild(entry, 'flags');
            const plaintext = messageNode && WABinary_1.getBinaryNodeChild(messageNode, 'plaintext');
            return {
                id: messageNode?.attrs?.id,
                t: messageNode?.attrs?.t ? Number(messageNode.attrs.t) : undefined,
                isSender: messageNode?.attrs?.is_sender === 'true',
                responseServerId: messageNode?.attrs?.response_server_id,
                sender: {
                    lid: sender?.attrs?.lid,
                    notifyName: sender?.attrs?.notify_name,
                    pictureDirectPath: picture?.attrs?.direct_path
                },
                replied: flags ? !!WABinary_1.getBinaryNodeChild(flags, 'replied') : false,
                starred: flags ? !!WABinary_1.getBinaryNodeChild(flags, 'starred') : false,
                message: decodeNewsletterPlaintext(plaintext)
            };
        })
    };
},

// 12. newsletterMyAddOns
newsletterMyAddOns: async (options = {}) => {
    return fetchMyAddOns(options, undefined);
},


// 14. subscribeNewsletterUpdates
subscribeNewsletterUpdates: async (jid) => {
    const result = await query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'set',
            xmlns: 'newsletter',
            to: jid
        },
        content: [{ tag: 'live_updates', attrs: {}, content: [] }]
    });
    const liveUpdatesNode = WABinary_1.getBinaryNodeChild(result, 'live_updates');
    const duration = liveUpdatesNode?.attrs?.duration;
    return duration ? { duration: duration } : null;
},

// 15. newsletterAdminCapabilities
newsletterAdminCapabilities: async (jid) => {
    const response = await executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.ADMIN_CAPABILITIES, Types_1.XWAPaths.xwa2_newsletter_admin_capabilities);
    return response?.capabilities ?? [];
},

// 19. newsletterCanPostStatus
newsletterCanPostStatus: async (jid) => {
    const capabilities = await executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.ADMIN_CAPABILITIES, Types_1.XWAPaths.xwa2_newsletter_admin_capabilities);
    const list = capabilities?.capabilities ?? [];
    return {
        canPost: list.includes('CHANNEL_STATUS_PRODUCER'),
        canPostMusic: list.includes('CHANNEL_STATUS_MUSIC'),
        capabilities: list
    };
},

// 20. newsletterAdminInfo
newsletterAdminInfo: async (jid) => {
    const response = await executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.ADMIN_INFO, Types_1.XWAPaths.xwa2_newsletter_admin_info);
    return {
        id: response?.id || jid,
        adminCount: response?.admin_count || 0,
        adminProfile: response?.admin_profile
            ? {
                id: response.admin_profile.id,
                name: response.admin_profile.name,
                picture: response.admin_profile.picture
                    ? {
                        id: response.admin_profile.picture.id,
                        directPath: response.admin_profile.picture.direct_path
                    }
                    : undefined
            }
            : undefined,
        adminProfilesEnabled: response?.admin_settings?.admin_profiles_enabled || false
    };
},



// 25. newsletterLabelAiContent
newsletterLabelAiContent: async (jid, serverId, messageType = 'MESSAGE') => {
    return executeWMexQuery({
        newsletter_id: jid,
        server_id: String(serverId),
        message_type: messageType
    }, Types_1.QueryIds.LABEL_AI_CONTENT, Types_1.XWAPaths.xwa2_newsletter_label_ai_content);
},

// 26. newsletterLabelPaidPartnership
newsletterLabelPaidPartnership: async (jid, serverId, messageType = 'MESSAGE') => {
    return executeWMexQuery({
        newsletter_id: jid,
        server_id: String(serverId),
        message_type: messageType
    }, Types_1.QueryIds.PAID_PARTNERSHIP_LABEL, Types_1.XWAPaths.xwa2_newsletter_label_paid_partnership);
},



// 31. newsletterDirectorySearch
newsletterDirectorySearch: async (searchText, options = {}) => {
    return executeWMexQuery({
        fetch_status_metadata: options.fetchStatusMetadata ?? false,
        input: {
            search_text: searchText,
            categories: options.categories ?? [],
            limit: options.limit ?? 20,
            start_cursor: options.cursorToken
        }
    }, Types_1.QueryIds.DIRECTORY_SEARCH, Types_1.XWAPaths.xwa2_newsletters_directory_search);
},

// 35. newsletterFollowers
newsletterFollowers: async (jid, options = {}) => {
    return executeWMexQuery({
        input: {
            newsletter_id: jid,
            count: options.count ?? 100
        }
    }, Types_1.QueryIds.FOLLOWERS, Types_1.XWAPaths.xwa2_newsletter_followers);
},

// 38. newsletterRecommended
newsletterRecommended: async (options = {}) => {
    return executeWMexQuery({
        fetch_status_metadata: options.fetchStatusMetadata ?? false,
        input: {
            limit: options.limit ?? 20,
            country_codes: ["MA"]
        }
    }, Types_1.QueryIds.RECOMMENDED, Types_1.XWAPaths.xwa2_newsletters_recommended);
}
    }
}

module.exports = { makeNewsletterSocket }
