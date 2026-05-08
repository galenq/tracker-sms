const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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

app.get("/messages", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("SUPABASE READ ERROR:", error);

      return res.json({
        success: true,
        messages
      });
    }

    res.json({
      success: true,
      messages: data
    });

  } catch (err) {
    console.error("MESSAGES ROUTE ERROR:", err);

    res.json({
      success: true,
      messages
    });
  }
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
    try {
      const { error: dbError } = await supabase
        .from("messages")
        .insert({
          direction: "outbound",
          from_number: process.env.TWILIO_NUMBER,
          to_number: to,
          body: message,
          message_sid: msg.sid,
          received_at: new Date().toISOString()
        });

      if (dbError) {
        console.error("SUPABASE OUTBOUND SAVE ERROR:", dbError);
      }
    } catch (dbCatchError) {
      console.error("SUPABASE OUTBOUND SAVE FAILED:", dbCatchError.message);
    }
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

app.post("/incoming-sms", async (req, res) => {

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
  try {
    const { error: dbError } = await supabase
      .from("messages")
      .insert({
        direction: "inbound",
        from_number: req.body.From,
        to_number: req.body.To,
        body: req.body.Body,
        message_sid: req.body.MessageSid,
        received_at: new Date().toISOString()
      });

    if (dbError) {
      console.error("SUPABASE INBOUND SAVE ERROR:", dbError);
    }
  } catch (dbCatchError) {
    console.error("SUPABASE INBOUND SAVE FAILED:", dbCatchError.message);
  }
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
