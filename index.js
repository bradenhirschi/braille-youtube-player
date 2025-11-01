import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ytdlp from "yt-dlp-exec";
import { Jimp } from "jimp";

const app = express();
app.use(express.static("public"));

const server = app.listen(3000, () =>
  console.log("Server running on http://localhost:3000")
);

const wss = new WebSocketServer({ server, path: "/ascii" });

wss.on("connection", ws => {
  ws.once("message", async msg => {
    const url = msg.toString();
    try {
      // 1. Stream video from YouTube
      const ytStream = ytdlp.exec(url, { o: "-", f: "mp4", q: "" });

      // 2. Extract low-res grayscale frames with ffmpeg
      const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-vf", "scale=600:450,format=gray,fps=10",
        "-f", "image2pipe",
        "-vcodec", "png",
        "pipe:1"
      ]);

      ytStream.stdout.pipe(ffmpeg.stdin);

      let buffer = Buffer.alloc(0);
      const frameQueue = [];
      let sending = false;
      const fps = 10;
      const interval = 1000 / fps;

      ffmpeg.stdout.on("data", async chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        const pngEnd = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
        while (buffer.includes(pngEnd)) {
          const index = buffer.indexOf(pngEnd) + pngEnd.length;
          const frameBuffer = buffer.slice(0, index);
          buffer = buffer.slice(index);

          // Queue frame
          frameQueue.push(frameBuffer);

          // Drop extra frames if too many in queue (prevents lag)
          // while (frameQueue.length > 5) frameQueue.shift();

          if (!sending) sendFrames();
        }
      });

      async function sendFrames() {
        sending = true;
        while (frameQueue.length) {
          const frame = frameQueue.shift();
          const ascii = await pngToAscii(frame);
          ws.send(ascii);
          await new Promise(r => setTimeout(r, interval));
        }
        sending = false;
      }

      ffmpeg.on("close", () => ws.close());
    } catch (err) {
      ws.send("Error: " + err.message);
      ws.close();
    }
  });
});

// Convert a PNG buffer to ASCII text
async function pngToAscii(buf) {
  const img = await Jimp.read(buf);
  const chars = " #";
  let out = "";

  const { data, width, height } = img.bitmap;

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 2) {
      const idx = (width * y + x) << 2; // multiply by 4

      // works dont toucuh above

      var n = 0
        | bitAt(data, getIndex(width, x, y)) << 0
        | bitAt(data, getIndex(width, x, y+ 1)) << 1
        | bitAt(data, getIndex(x, y+ 2)) << 2
        | bitAt(data, getIndex(x + 1, y)) << 3
        | bitAt(data, getIndex(x + 1, y +1)) << 4
        | bitAt(data, getIndex(x + 1, y +2)) << 5
        | bitAt(data, getIndex(x, y + 3)) << 6
        | bitAt(data, getIndex(x + 1, y + 3)) << 7;

      out += String.fromCharCode(0x2800 + n);

      // works dont touch below
      // out += bitAt(data, idx);
    }
    out += "\n";
  }

  return out;
}

function getIndex(width, x, y) {
  return (width * y + x) << 2;
}

function bitAt(data, idx) {
  const r = data[idx + 0];
  const g = data[idx + 1];
  const b = data[idx + 2];

  // Compute brightness/luminance
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;

  const bit = Math.round(gray / 255);

  return bit;
}
