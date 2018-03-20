const stream = require('stream');
const timers = require('timers');
const url = require('url');
const debug = require('debug')('net');


/* Normalize connect() args from the old API to the new object-based one. */
function normalizeConnectArgs(args) {
	let options = {};
	if (typeof args[0] === 'object' && args[0] !== null) {
		/* connect(options, [cb]) */
		options = args[0];
	} else if (typeof args[0] === 'string') {
		/* connect(path, [cb]); */
		options.wsurl = args[0];
	} else {
		/* connect(port, [host], [cb]) */
		options.port = args[0];
		if (typeof args[1] === 'string') {
			options.host = args[1];
		}
	}
	const cb = args[args.length - 1];
	return (typeof cb === 'function') ? [options, cb] : [options];
}


class Socket extends stream.Duplex {

	constructor(options) {
		options = options || {};
		options.decodeStrings = false;
		super(options);

		this.bufferSize = undefined;

		this.remoteAddress = null;
		this.remoteFamily = null;
		this.remotePort = null;

		this.localAddress = null;
		this.localPort = null;

		this.bytesRead = 0;
		this.bytesWritten = 0;

		this.connecting = false;
		this.readable = this.writable = false;
		this.allowHalfOpen = options.allowHalfOpen || false;
		
		this._timer = null;
		this._timeout = null;
		this._ws = null;
		this._encoder = null;
		this._encoding = null;
	}


	/** Socket API */

	setKeepAlive(setting, msecs) {
		/* XXX: not trivially implementable */
		return this;
	}

	setNoDelay() {
		/* XXX: not relevant for WebSockets */
		return this;
	}

	setTimeout(msecs, callback) {
		if (msecs > 0 && isFinite(msecs)) {
			this._timeout = msecs;
			this._refreshTimer();
			if (callback) {
				this.once('timeout', callback);
			}
		} else if (msecs === 0) {
			this._timeout = null;
			if (this._timer) {
				timers.clearTimeout(this._timer);
				this._timer = null;
			}
			if (callback) {
				this.removeListener('timeout', callback);
			}
		}
		return this;	
	}
	
	_refreshTimer() {
		if (this._timer) {
			timers.clearTimeout(this._timer);
		}
		if (this._timeout !== null) {
			this._timer = timers.setTimeout(() => this.emit('timeout'), this._timeout);
		}
	}


	address() {
		return {
			address: this.remoteAddress,
			port: this.remotePort,
			family: this.remoteFamily
		};	
	}

	listen() {
		throw new Error('Cannot listen in a browser');
	}

	/* Our connect() processes three additional entries in `options`:
	 * - wsurl: Full WebSocket URL to connect to, automatically filled in if the first argument is a string;
	 * - wspath: The HTTP path component for the WebSocket URL if host and port are given separately;
	 * - wsprotocols: List of WebSocket protocols to accept (see second argument to WebSocket constructor).
	 */
	connect(options, cb) {
		if (options === null || typeof options !== 'object') {
			/* Convert from legacy API */
			return this.connect(...normalizeConnectArgs([options, cb]));
		}
		if (options.path) {
			throw new Error('options.path not supported in the browser');
		}
		for (let x of ['localAddress', 'localPort', 'hints', 'lookup']) {
			if (x in options) {
				console.warn(`options.${x} not supported in the browser, silently ignored`);
			}
		}

		/* Already connected? */
		if (this._ws) {
			if (cb) {
				process.nextTick(() => cb());
			}
			return this;
		}

		if (cb) {
			this.on('connect', cb);
		}
		this._refreshTimer();

		/* Construct WebSockets URL from options. */
		let target;
		if (options.wsurl) {
			target = url.parse(options.wsurl);
		} else {
			target = url.parse(
				(options.protocol || 'ws://') +
				(options.host || 'localhost') + ':' + (options.port || 8080) +
				(options.wspath || '/'));
		}

		this.connecting = true;
		this.writable = true;
		this.remoteAddress = url.hostname;
		this.remotePort = url.port;
		this.remoteFamily = {4: 'IPv4', 6: 'IPv6'}[options.family || 4] || 'IPv4';

		/* Create and set up WebSocket. */
		this._ws = new WebSocket(url.format(target), options.wsprotocols || []);
		this._ws.binaryType = 'arraybuffer';
		this._ws.addEventListener('open', () => {
			this._refreshTimer();
			this.connecting = false;
			this.readable = true;

			this.emit('connect');
			this.read(0);
		});
		this._ws.addEventListener('message', (e) => {
			this._refreshTimer();
			const buffer = Buffer.from(e.data);
			this.bytesRead += buffer.length;
			this.push(buffer);
		});
		this._ws.addEventListener('error', (e) => {
			/* Real error information is given in the close event, so don't emit anything here. */
			this._refreshTimer();
		});
		this._ws.addEventListener('close', (e) => {
			this._refreshTimer();
			if (e.code > 1000 && e.code < 3000 && (e.wasClean === undefined || !e.wasClean)) {
				this.emit('error', `[WebSocket error ${e.code}] ${e.reason}`);
			}
			if (!this.destroyed) {
				/* Emit EOF and close: WebSockets can't be write-only. */
				this.push(null);
				this.destroy();
			}
		});

		return this;
	}

	end(data, encoding) {
		super.end(data, encoding);
		this.writable = false;

		if (!this.destroyed && (!this.allowHalfOpen || !this.readable)) {
			this.destroy();
		}

		return this;
	}

	
	/** Duplex API */

	_read() {
		/* WebSockets have no explicit read method, it's all handled through 'message' events. */
	}

	_write(data, encoding, cb) {
		this._refreshTimer();

		/* Buffer up writes while connecting. */
		if (this.connecting) {
			this.once('connect', () => {
				this._write(data, encoding, cb);
			});
			return;
		}

		/* Encode data properly. */
		if (typeof data === 'string') {
			if (encoding !== this._encoding) {
				this._encoding = encoding;
				this._encoder = new TextEncoder(encoding);
			}
			data = this._encoder.encode(data).buffer;
		}

		/* Best approximation for when writing is complete, as there is no 'sent' event in WebSockets. */
		this._ws.send(data);
		process.nextTick(() => {
			this.bytesWritten += data.length;
			if (cb) cb();
		});
	}

	_destroy(err, cb) {
		if (this.destroyed) {
			return;
		}

		this.destroyed = true;
		this.connecting = false;
		this.readable = this.writable = false;

		if (this._ws) {
			this._ws.close();
			this._ws = null;
		}
		if (this._timer) {
			this._timeout = null;
			this._refreshTimer();
		}
		if (cb) {
			cb(err);
		}
	}

}

Object.defineProperty(Socket.prototype, 'readyState', {
	get: function() {
		if (this.connecting) {
			return 'opening';
		} else if (this.readable && this.writable) {
			return 'open';
		} else if (this.readable && !this.writable) {
			return 'readOnly';
		} else if (!this.readable && this.writable) {
			return 'writeOnly';
		} else {
			return 'closed';
		}
	}
});

function createServer(...args) {
	throw new Error('Cannot create server in a browser');
}

function createConnection(...args) {
	args = normalizeConnectArgs(args);
	const s = new Socket(args[0]);
	return s.connect(...args);
}

function isIP(input) {
	if (isIPv4(input)) {
		return 4;
	} else if (isIPv6(input)) {
		return 6;
	} else {
		return 0;
	}
};

function isIPv4(input) {
	return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(input);
};

function isIPv6(input) {
	return /^(([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))$/.test(input);
};

module.exports = {
	Socket,
	Stream: Socket,
        createServer,
        createConnection,
        connect: createConnection,
	isIP,
	isIPv4,
	isIPv6
};
