"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const Defaults_1 = require("../Defaults")
const business_1 = require("./business")
const { sendPrivateRelay } = require('./send-private-relay')

// export the last socket layer
const makeWASocket = (config) => {
	const newConfig = {
    	...Defaults_1.DEFAULT_CONNECTION_CONFIG,
   	 ...config
    }
    
    // If the user hasn't provided their own history sync function,
    // let's create a default one that respects the syncFullHistory flag.
    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
    }

    const sock = business_1.makeBusinessSocket(newConfig)
    sock.sendPrivateRelay = (groupJid, targets, options) =>
        sendPrivateRelay(sock, groupJid, targets, options)
    Object.defineProperty(sock, 'user', {
        enumerable: true,
        configurable: true,
        get() {
            const user = sock.authState.creds.me
            if (user?.id) user.jid = sock.decodeJid(user.id)
            return user
        }
    })
    return sock
}

exports.default = makeWASocket