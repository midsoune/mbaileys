"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const { format } = require("util")

const levels = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
    silent: Infinity
}

const color = (code, value) => {
    if (!process.stdout.isTTY) return value
    return `\u001b[${code}m${value}\u001b[0m`
}

const makeLogger = (state, bindings = {}) => {
    const write = (level, label, labelColor, messageColor, args) => {
        if (levels[level] < levels[state.level]) return

        const timestamp = color("38;2;255;255;255", new Date().toUTCString())
        const message = format(...(Object.keys(bindings).length ? [bindings, ...args] : args))
        console.log(
            color(labelColor, label),
            `[${timestamp}]:`,
            color(messageColor, message)
        )
    }

    const logger = {
        trace(...args) {
            write("trace", "TRACE ", "90", "37", args)
        },
        debug(...args) {
            write("debug", "DEBUG ", "1;48;2;66;167;245", "37", args)
        },
        info(...args) {
            write("info", "INFO ", "1;48;2;51;204;51", "36", args)
        },
        warn(...args) {
            write("warn", "WARN ", "1;48;2;255;153;0", "91", args)
        },
        error(...args) {
            write("error", "ERROR ", "1;48;2;247;38;33", "38;2;255;38;0", args)
        },
        fatal(...args) {
            write("fatal", "FATAL ", "1;48;2;247;38;33", "38;2;255;38;0", args)
        },
        child(childBindings = {}) {
            return makeLogger(state, { ...bindings, ...childBindings })
        },
        isLevelEnabled(level) {
            return levels[level] !== undefined && levels[level] >= levels[state.level]
        }
    }

    Object.defineProperty(logger, "level", {
        enumerable: true,
        get: () => state.level,
        set: level => {
            if (levels[level] === undefined) {
                throw new RangeError(`Unknown log level: ${level}`)
            }
            state.level = level
        }
    })

    return logger
}

exports.default = makeLogger({ level: "error" })
