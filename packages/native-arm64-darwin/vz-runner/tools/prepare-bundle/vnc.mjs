// Minimal RFB client for scripting a macOS guest through Setup Assistant.
// Fixture tooling. Not shipped.
//
//   node vnc.mjs <vnc-info.json> shot <out.png>
//   node vnc.mjs <vnc-info.json> type <text>
//   node vnc.mjs <vnc-info.json> keys <name> [<name>...]     e.g. tab space enter
//   node vnc.mjs <vnc-info.json> combo <mods+key>            e.g. cmd+space
//   node vnc.mjs <vnc-info.json> click <x> <y>
//
// Coordinates are framebuffer pixels, as they appear in `shot` output.

import { createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";

const NAMED_KEYS = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  esc: 0xff1b,
  escape: 0xff1b,
  space: 0x20,
  backspace: 0xff08,
  delete: 0xffff,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  home: 0xff50,
  end: 0xff57,
  f2: 0xffbf,
  f5: 0xffc2,
};

const MODIFIERS = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  option: 0xffe9,
  cmd: 0xffeb,
  command: 0xffeb,
  meta: 0xffeb,
};

// Printable characters that need shift on a US layout.
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class Rfb {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length > 0 && this.buffer.length >= this.waiters[0].size) {
      const { size, resolve } = this.waiters.shift();
      const data = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      resolve(data);
    }
  }

  read(size) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ size, resolve, reject });
      this.pump();
    });
  }

  write(data) {
    this.socket.write(data);
  }

  async handshake(password) {
    const version = await this.read(12);
    process.stderr.write(`server ${version.toString().trim()}\n`);
    this.write(Buffer.from("RFB 003.008\n"));
    const typeCount = (await this.read(1))[0];
    if (typeCount === 0) {
      const length = (await this.read(4)).readUInt32BE(0);
      throw new Error(`server refused: ${(await this.read(length)).toString()}`);
    }
    const types = [...(await this.read(typeCount))];
    if (!types.includes(2)) {
      throw new Error(`server offers security types ${types.join(",")}, not VNC auth`);
    }
    this.write(Buffer.from([2]));
    this.write(encryptChallenge(await this.read(16), password));
    const result = (await this.read(4)).readUInt32BE(0);
    if (result !== 0) {
      throw new Error("VNC authentication failed");
    }
    this.write(Buffer.from([1]));
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    await this.read(init.readUInt32BE(20));
    const pixelFormat = Buffer.alloc(20);
    pixelFormat[0] = 0;
    pixelFormat[4] = 32;
    pixelFormat[5] = 24;
    pixelFormat[6] = 0;
    pixelFormat[7] = 1;
    pixelFormat.writeUInt16BE(255, 8);
    pixelFormat.writeUInt16BE(255, 10);
    pixelFormat.writeUInt16BE(255, 12);
    pixelFormat[14] = 16;
    pixelFormat[15] = 8;
    pixelFormat[16] = 0;
    this.write(pixelFormat);
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(0, 4);
    this.write(encodings);
  }

  async screenshot() {
    const pixels = Buffer.alloc(this.width * this.height * 4);
    const request = Buffer.alloc(10);
    request[0] = 3;
    request[1] = 0;
    request.writeUInt16BE(this.width, 6);
    request.writeUInt16BE(this.height, 8);
    this.write(request);
    for (;;) {
      const type = (await this.read(1))[0];
      if (type === 0) {
        break;
      }
      if (type === 2) {
        continue;
      }
      if (type === 1) {
        const header = await this.read(5);
        await this.read(header.readUInt16BE(3) * 6);
      } else if (type === 3) {
        const header = await this.read(7);
        await this.read(header.readUInt32BE(3));
      } else {
        throw new Error(`unexpected server message ${type}`);
      }
    }
    const header = await this.read(3);
    for (let rect = 0; rect < header.readUInt16BE(1); rect++) {
      const rectHeader = await this.read(12);
      const x = rectHeader.readUInt16BE(0);
      const y = rectHeader.readUInt16BE(2);
      const width = rectHeader.readUInt16BE(4);
      const height = rectHeader.readUInt16BE(6);
      const encoding = rectHeader.readInt32BE(8);
      if (encoding !== 0) {
        throw new Error(`unsupported encoding ${encoding}`);
      }
      const data = await this.read(width * height * 4);
      for (let row = 0; row < height; row++) {
        data.copy(pixels, ((y + row) * this.width + x) * 4, row * width * 4, (row + 1) * width * 4);
      }
    }
    return pixels;
  }

  async key(keysym, down) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym, 4);
    this.write(message);
  }

  async tap(keysym) {
    await this.key(keysym, true);
    await delay(30);
    await this.key(keysym, false);
    await delay(30);
  }

  async pointer(x, y, buttons) {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = buttons;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    this.write(message);
    await delay(60);
  }
}

// VNC authentication is DES with each key byte's bits reversed. Triple DES with
// three identical keys is single DES, and OpenSSL no longer enables DES itself.
function encryptChallenge(challenge, password) {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) {
      reversed |= ((key[i] >> bit) & 1) << (7 - bit);
    }
    key[i] = reversed;
  }
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

function encodePng(pixels, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const target = rowStart + 1 + x * 3;
      raw[target] = pixels[source + 2];
      raw[target + 1] = pixels[source + 1];
      raw[target + 2] = pixels[source];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function typeText(rfb, text) {
  for (const char of text) {
    const keysym = char === "\n" ? NAMED_KEYS.enter : char.codePointAt(0);
    const shifted = SHIFTED.includes(char);
    if (shifted) {
      await rfb.key(MODIFIERS.shift, true);
    }
    await rfb.tap(keysym);
    if (shifted) {
      await rfb.key(MODIFIERS.shift, false);
    }
  }
}

function keysymFor(name) {
  const lower = name.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined) {
    return NAMED_KEYS[lower];
  }
  if ([...name].length === 1) {
    return name.codePointAt(0);
  }
  throw new Error(`unknown key ${name}`);
}

async function main() {
  const [infoPath, command, ...args] = process.argv.slice(2);
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  const socket = connect({ host: "127.0.0.1", port: info.port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const rfb = new Rfb(socket);
  await rfb.handshake(info.password);
  switch (command) {
    case "shot": {
      const pixels = await rfb.screenshot();
      writeFileSync(args[0], encodePng(pixels, rfb.width, rfb.height));
      console.log(`${rfb.width}x${rfb.height} -> ${args[0]}`);
      break;
    }
    case "type":
      await typeText(rfb, args.join(" "));
      break;
    case "keys":
      for (const name of args) {
        await rfb.tap(keysymFor(name));
        await delay(120);
      }
      break;
    case "combo": {
      const parts = args[0].split("+");
      const key = keysymFor(parts.pop());
      const mods = parts.map((part) => MODIFIERS[part.toLowerCase()]);
      for (const mod of mods) {
        await rfb.key(mod, true);
        await delay(40);
      }
      await rfb.tap(key);
      for (const mod of mods.reverse()) {
        await rfb.key(mod, false);
        await delay(40);
      }
      break;
    }
    case "click": {
      const x = Number(args[0]);
      const y = Number(args[1]);
      await rfb.pointer(x, y, 0);
      await rfb.pointer(x, y, 1);
      await rfb.pointer(x, y, 0);
      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
  await delay(100);
  socket.end();
  socket.destroy();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
