const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

app.use(cors());
app.use(bodyParser.json());

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);

app.get("/", (req, res) => {
  res.send("Tracker SMS bridge is running.");
});

app.post("/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ success: false, error: "Missing to or message." });
    }

    const msg = await client.messages.create({
      body: message,
      from: process.env.TWILIO_NUMBER,
      to
    });

    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Tracker SMS bridge running on port " + port);
});
