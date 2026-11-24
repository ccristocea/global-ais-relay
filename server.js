const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
app.use(cors());

const API_KEY = process.env.AISSTREAM_API_KEY;
const vessels = new Map();
let streamConnected = false;

function connectAIS() {
  if (!API_KEY) {
    console.error("Missing AISSTREAM_API_KEY environment variable.");
    return;
  }

  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    streamConnected = true;
    ws.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const meta = msg.MetaData || {};
      const mmsi = meta.MMSI || meta.MMSI_String;
      if (!mmsi) return;

      const existing = vessels.get(mmsi) || { mmsi };
      existing.updatedAt = Date.now();

      if (meta.ShipName) existing.name = meta.ShipName.trim();
      if (typeof meta.Latitude === "number") existing.lat = meta.Latitude;
      if (typeof meta.Longitude === "number") existing.lon = meta.Longitude;

      if (msg.MessageType === "PositionReport" && msg.Message?.PositionReport) {
        const p = msg.Message.PositionReport;
        if (typeof p.Latitude === "number" && Math.abs(p.Latitude) <= 90) existing.lat = p.Latitude;
        if (typeof p.Longitude === "number" && Math.abs(p.Longitude) <= 180) existing.lon = p.Longitude;
        existing.sog = p.Sog;
        existing.cog = p.Cog;
        existing.heading = p.TrueHeading;
        existing.navStat = p.NavigationalStatus;
      } else if (msg.MessageType === "ShipStaticData" && msg.Message?.ShipStaticData) {
        const s = msg.Message.ShipStaticData;
        if (s.Name) existing.name = s.Name.trim();
        existing.shipType = s.Type;
        existing.imo = s.ImoNumber;
        existing.callSign = s.CallSign?.trim();
        existing.destination = s.Destination?.trim();
        existing.draught = s.MaximumStaticDraught;
        existing.dim = s.Dimension;
      }

      vessels.set(mmsi, existing);
    } catch (err) {
      console.error("AIS parse error:", err.message);
    }
  });

  ws.on("close", () => {
    streamConnected = false;
    setTimeout(connectAIS, 5000);
  });

  ws.on("error", (err) => {
    streamConnected = false;
    console.error("AIS socket error:", err.message);
  });
}

setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [mmsi, v] of vessels) {
    if (v.updatedAt < cutoff) vessels.delete(mmsi);
  }
}, 60 * 1000);

connectAIS();

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    streamConnected,
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

app.listen(process.env.PORT || 3000);
