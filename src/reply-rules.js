function isReplyToForwardedStudentMessage(message) {
  if (!message || !message.reply_to_message) {
    return false;
  }

  return Boolean(message.reply_to_message.message_id);
}

function getRepresentativeReplyGuidance() {
  return (
    "📩 እባክዎ ለተማሪው ምላሽ በተላከው forwarded student message ላይ Reply / መልስ ይጠቀሙ።\n\n" +
    "እዚህ ጋር ያለው ተራ መልዕክት አይላክም።\n\n" +
    "Reply ካልሆነ ተማሪው አይቀበልም።"
  );
}

module.exports = {
  isReplyToForwardedStudentMessage,
  getRepresentativeReplyGuidance,
};
