const stream = require('stream');
const timers = require('timers');
const url = require('url');
const debug = require('debug')('net');


function toNumber(x) {
	return (x = Number(x)) >= 0 ? x : false;
}

function isPipeName(s) {
	return typeof s === 'string' && toNumber(s) === false;
}

/* Normalize connect() args from the old API to the new object-based one. */
function normalizeConnectArgs(args) {
	let options = {};
	if (typeof args[0] == 'object' && args[0] !== null) {
		// connect(options, [cb])
		options = args[0];
	} else if (isPipeName(args[0])) {
		// connect(path, [cb]);
		options.wsurl = args[0];
	} else {
		// connect(port, [host], [cb])
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
		super(options || {});

		this.bufferSize = undefined;

		this.remoteAddress = null;
		this.remoteFamily = null;
		this.remotePort = null;

		this.localAddress = null;
		this.localPort = null;

		this.bytesRead = 0;
		this.bytesWritten = 0;

		this.connecting = false;
		
		this._timer = null;
		this._timeout = null;
		this._ws = null;
		
		this.readable = this.writable = false;
		this._writableState.decodeStrings = false;
		this.allowHalfOpen = options && options.allowHalfOpen || false;
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

	connect(options, cb) {
		if (options === null || typeof options !== 'object') {
			/* Convert from legacy API */
			return this.connect(normalizeConnectArgs([options, cb]));
		}
		if (options.path) {
			throw new Error('options.path not supported in the browser');
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

		/* Construct WebSockets URL and fill in public fields */
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
		this.remoteFamily = 'IPv4'; /* TODO: fix */

		/* Setup WebSocket */
		this._ws = new WebSocket(url.format(target));
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
			if (this.readyState != 'closed') {
				this.destroy();
			}
		});

		return this;
	}

	end(data, encoding) {
		super.end(data, encoding);
		this.writable = false;

		if (this._ws) {
			this._ws.close();
			this._ws = null;
		}

		/* In case we're waiting for an EOF */
		if (this.readable && !this._readableState.endEmitted)
			this.read(0);
		else
			this._maybeDestroy();
		
		return this;
	}

	_maybeDestroy() {
		if (this.readyState == 'closed' && !this._writableState.length) {
			this.destroy();
		}
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
		if (typeof data == 'string') {
			data = (new TextEncoder(encoding)).encode(data).buffer;
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

		this.connecting = false;
		this.readable = this.writable = false;

		if (this._timer) {
			this._timeout = null;
			this._refreshTimer();
		}

		this.destroyed = true;
		if (cb) {
			cb(err);
		}

		return this;
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
	return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(input);
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
