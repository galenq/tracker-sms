const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);

/*
================================================
PHASE 2 MESSAGE STORAGE
================================================
Stores BOTH:
- inbound replies
- outbound sent messages

IMPORTANT:
This is temporary memory storage only.
Messages reset if Render restarts/redeploys.
================================================
*/

let messages = [];

app.get("/", (req, res) => {
  res.send("Tracker SMS bridge is running.");
});

/*
================================================
GET ALL MESSAGES
================================================
*/

app.get("/messages", (req, res) => {
  res.json({
    success: true,
    messages
  });
});

/*
================================================
SEND SMS
================================================
*/

app.post("/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Missing to or message."
      });
    }

    const msg = await client.messages.create({
      body: message,
      from: process.env.TWILIO_NUMBER,
      to
    });

    /*
    ================================================
    SAVE OUTBOUND MESSAGE
    ================================================
    */

    messages.unshift({
      direction: "outbound",
      from: process.env.TWILIO_NUMBER,
      to,
      body: message,
      messageSid: msg.sid,
      receivedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      sid: msg.sid
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/*
================================================
INBOUND SMS WEBHOOK
================================================
*/

app.post("/incoming-sms", (req, res) => {

  console.log("INBOUND SMS:", req.body);

  /*
  ================================================
  SAVE INBOUND MESSAGE
  ================================================
  */

  messages.unshift({
    direction: "inbound",
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body,
    messageSid: req.body.MessageSid,
    receivedAt: new Date().toISOString()
  });

  const twiml = new twilio.twiml.MessagingResponse();

  twiml.message(
    "U.S. Truck Dispatch received your message. Reply STOP to unsubscribe or HELP for assistance."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Tracker SMS bridge running on port " + port);
});
