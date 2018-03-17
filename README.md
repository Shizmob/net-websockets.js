# net-websockets.js

`net` module drop-in for browserify, based on WebSockets. Heavily based on [net-browserify](https://github.com/emersion/net-browserify).

## Usage

`require()` this module or map `net` to it using the `browser` key in `package.json`:

```json
{
    ...
    "browser": {
        "net": "net-websockets"
    }
}```

Then you can use it to connect to WebSocket nodes. I recommend [websocat](https://github.com/vi/websocat) or [websocketd](https://github.com/joewalnes/websocketd) for 
proxy options.

## License

```
The MIT License (MIT)

Copyright (c) 2014 emersion
Copyright (c) 2017 Shiz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
