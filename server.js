const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
app.use(cors());

const API_KEY = process.env.AISSTREAM_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.warn("WARNING: AISSTREAM_API_KEY environment variable is not set.");
}

const vessels = new Map();
let wsConnected = false;

function connectAIS() {
  if (!API_KEY) return;

  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    wsConnected = true;
    console.log("Connected to aisstream.io global stream");
    ws.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const mmsi = msg.MetaData && msg.MetaData.MMSI;
      if (!mmsi) return;

      const existing = vessels.get(mmsi) || { mmsi };
      existing.updatedAt = Date.now();

      if (msg.MetaData.ShipName && msg.MetaData.ShipName.trim()) {
        existing.name = msg.MetaData.ShipName.trim();
      }

      if (msg.MessageType === "PositionReport") {
        const p = msg.Message.PositionReport;
        existing.lat = msg.MetaData.Latitude;
        existing.lon = msg.MetaData.Longitude;
        existing.sog = p.Sog;
        existing.cog = p.Cog;
        existing.heading = p.TrueHeading;
        existing.navStat = p.NavigationalStatus;
      } else if (msg.MessageType === "ShipStaticData") {
        const s = msg.Message.ShipStaticData;
        existing.shipType = s.Type;
        existing.imo = s.ImoNumber;
        if (s.CallSign && s.CallSign.trim()) existing.callSign = s.CallSign.trim();
        if (s.Destination && s.Destination.trim()) existing.destination = s.Destination.trim();
        existing.draught = s.MaximumStaticDraught;
        existing.dim = s.Dimension;
      }

      vessels.set(mmsi, existing);
    } catch (err) {
      // Ignore malformed frames
    }
  });

  ws.on("close", () => {
    wsConnected = false;
    console.log("AISStream disconnected. Reconnecting in 5s...");
    setTimeout(connectAIS, 5000);
  });

  ws.on("error", (err) => {
    console.error("AISStream error:", err.message);
  });
}

// Prune vessels silent for more than 20 minutes
setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [mmsi, v] of vessels.entries()) {
    if (v.updatedAt < cutoff) {
      vessels.delete(mmsi);
    }
  }
}, 60 * 1000);

connectAIS();

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    streamConnected: wsConnected,
    activeVessels: vessels.size,
    endpoints: ["/ships"]
  });
});

app.get("/ships", (req, res) => {
  const list = [];
  for (const v of vessels.values()) {
    if (typeof v.lat === "number" && typeof v.lon === "number") {
      list.push(v);
    }
  }
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`Global AIS Relay running on port ${PORT}`);
});
