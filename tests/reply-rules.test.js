const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isReplyToForwardedStudentMessage,
  getRepresentativeReplyGuidance,
} = require("../src/reply-rules");

test("detects when representative is replying to a forwarded student message", () => {
  const message = {
    reply_to_message: {
      message_id: 42,
      from: { id: 123 },
    },
  };

  assert.equal(isReplyToForwardedStudentMessage(message), true);
});

test("returns guidance when a representative sends a normal message instead of a reply", () => {
  const guidance = getRepresentativeReplyGuidance();

  assert.match(guidance, /reply/i);
  assert.match(guidance, /forwarded/i);
});
