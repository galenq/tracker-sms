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
INBOUND SMS / MMS WEBHOOK
================================================
*/

app.post("/incoming-sms", async (req, res) => {

  console.log("INBOUND SMS/MMS:", req.body);

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

  /*
  ================================================
  SAVE INBOUND MMS / DOCUMENTS
  ================================================
  */

  try {
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaContentType = req.body[`MediaContentType${i}`];

        let documentType = "Other Document";

        const bodyText = (req.body.Body || "").toLowerCase();

        if (bodyText.includes("pod")) {
          documentType = "POD";
        } else if (bodyText.includes("bol")) {
          documentType = "BOL";
        } else if (bodyText.includes("lumper")) {
          documentType = "Lumper Receipt";
        } else if (bodyText.includes("invoice")) {
          documentType = "Invoice";
        } else if (bodyText.includes("damage")) {
          documentType = "Damage Photo";
        } else if (mediaContentType && mediaContentType.startsWith("image/")) {
          documentType = "Photo";
        }

        const { error: mediaError } = await supabase
          .from("media_messages")
          .insert({
            direction: "inbound",
            from_number: req.body.From,
            to_number: req.body.To,
            body: req.body.Body,
            message_sid: req.body.MessageSid,
            media_url: mediaUrl,
            media_content_type: mediaContentType,
            media_index: String(i),
            document_type: documentType,
            status: "received"
          });

        if (mediaError) {
          console.error("SUPABASE MMS SAVE ERROR:", mediaError);
        }
      }
    }
  } catch (mediaCatchError) {
    console.error("SUPABASE MMS SAVE FAILED:", mediaCatchError.message);
  }

  const twiml = new twilio.twiml.MessagingResponse();

  twiml.message(
    "U.S. Truck Dispatch received your message. Reply STOP to unsubscribe or HELP for assistance."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});
const port = process.env.PORT || 3000;
app.post("/save-location", async (req, res) => {
  try {
    const {
      phone_number,
      driver_name,
      latitude,
      longitude,
      location_label,
      map_link,
      status
    } = req.body;

    const { error } = await supabase
      .from("locations")
      .insert([
        {
          phone_number,
          driver_name,
          latitude,
          longitude,
          location_label,
          map_link,
          status
        }
      ]);

    if (error) {
      console.error("LOCATION SAVE ERROR:", error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true
    });

  } catch (err) {
    console.error("SAVE LOCATION ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/media-messages", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("media_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("MEDIA MESSAGES READ ERROR:", error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      media_messages: data
    });

  } catch (err) {
    console.error("MEDIA MESSAGES ROUTE ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/media-file", async (req, res) => {
  try {
    const mediaUrl = req.query.url;

    if (!mediaUrl) {
      return res.status(400).send("Missing media URL.");
    }

    if (!mediaUrl.startsWith("https://api.twilio.com/")) {
      return res.status(400).send("Invalid media URL.");
    }

    const response = await fetch(mediaUrl, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.TWILIO_SID + ":" + process.env.TWILIO_AUTH
          ).toString("base64")
      }
    });

    if (!response.ok) {
      console.error("TWILIO MEDIA FETCH ERROR:", response.status);
      return res.status(response.status).send("Could not load media file.");
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = await response.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("MEDIA FILE ROUTE ERROR:", err);

    res.status(500).send("Media file route failed.");
  }
});

app.get("/locations", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("locations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      console.error("LOCATION READ ERROR:", error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      locations: data
    });

  } catch (err) {
    console.error("LOCATIONS ROUTE ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
app.listen(port, () => {
  console.log("Tracker SMS bridge running on port " + port);
});
