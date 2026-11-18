// Cloudflare Email Worker
// Receives every email routed to it (e.g. contact@ / catch-all) and passes the raw message to the inbox server.
// If the server can't be reached, the email is forwarded to a backup address instead, so nothing is lost.
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   INBOX_URL       = https://admin.example.com/api/inbound   (plain text variable)
//   FALLBACK_TO     = backup@example.com                      (plain text variable, must be a verified Email Routing destination)
//   INBOUND_SECRET  = <long random string>                    (SECRET, same value as INBOUND_SECRET on the server)

export default {
  async email(message, env, ctx) {
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const res = await fetch(env.INBOX_URL, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-inbound-secret": env.INBOUND_SECRET,
          "x-envelope-from": message.from,
          "x-envelope-to": message.to,
        },
        body: raw,
      });
      if (!res.ok) throw new Error(`inbox responded ${res.status}`);
    } catch (err) {
      console.log("Inbox delivery failed, forwarding to backup:", err.message);
      await message.forward(env.FALLBACK_TO);
    }
  },
};
