require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const departments = require("./departments");
const storage = require("./storage");
const {
  normalizeUsername,
  getDepartmentRepUsernames,
  getDepartmentIdsForRepresentative,
  getAdminUsernames,
  getAdminChatIds,
  getGlobalRecipientUsernames,
} = require("./rep-config");
const {
  isReplyToForwardedStudentMessage,
  getRepresentativeReplyGuidance,
} = require("./reply-rules");

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing in .env file");
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const userSelections = new Map();
const replyMap = storage.getReplyMap();

function buildReplyMenu() {
  return {
    keyboard: [[{ text: "✍️ Send Message" }]],
    resize_keyboard: true,
    one_time_keyboard: false,
    selective: true,
  };
}

function getDepartmentById(departmentId) {
  return departments.find((item) => item.id === departmentId);
}

function getSubDepartmentById(subDepartmentId) {
  for (const department of departments) {
    if (!department.subDepartments) continue;
    const found = department.subDepartments.find((sub) => sub.id === subDepartmentId);
    if (found) {
      return {
        department,
        subDepartment: found,
      };
    }
  }

  return null;
}

function isAdminUser(ctx) {
  const username = normalizeUsername(ctx.from.username);
  const adminUsernames = getAdminUsernames();
  const adminChatIds = getAdminChatIds();

  return adminUsernames.includes(username) || adminChatIds.includes(Number(ctx.from.id));
}

function getConfiguredRepresentativeUsernames() {
  const usernames = new Set();

  for (const department of departments) {
    for (const username of getDepartmentRepUsernames(department.id)) {
      usernames.add(username);
    }

    if (department.subDepartments) {
      for (const subDepartment of department.subDepartments) {
        for (const username of getDepartmentRepUsernames(subDepartment.id)) {
          usernames.add(username);
        }
      }
    }
  }

  return Array.from(usernames);
}

function registerRepresentativeIfConfigured(ctx) {
  const username = normalizeUsername(ctx.from.username);
  if (!username) return false;

  const configuredDepartments = getDepartmentIdsForRepresentative(username);
  if (!configuredDepartments.length) return false;

  storage.upsertRepresentative({
    telegramUserId: ctx.from.id,
    chatId: ctx.chat.id,
    username,
    firstName: ctx.from.first_name,
    lastName: ctx.from.last_name,
    isAdmin: isAdminUser(ctx),
  });

  for (const departmentId of configuredDepartments) {
    storage.assignDepartmentRepresentative({
      departmentId,
      representativeUserId: ctx.from.id,
      username,
      chatId: ctx.chat.id,
    });
  }

  return true;
}

async function showMainMenu(ctx) {
  await ctx.reply(
    "📂 እባክዎ መልዕክትዎን ማድረስ የሚፈልጉበትን ክፍል ይምረጡ።",
    {
      reply_markup: {
        inline_keyboard: makeKeyboard(departments).reply_markup.inline_keyboard,
      },
    },
  );


}

async function askForMessage(ctx, department) {
  userSelections.set(ctx.from.id, department);

  await ctx.reply(
    `📂 የመረጡት ክፍል፦ ${department.name}\n\n` +
      "✍️ እባክዎ ሃሳብዎን፣ ጥያቄዎን ወይም አስተያየትዎን አሁን ይጻፉ።\n\n" +
      "❌ ለመሰረዝ /cancel ይጻፉ።",
  );
}

function makeKeyboard(items) {
  const rows = [];
  const mainOffice = items.find((item) => item.id === "main_office");

  if (mainOffice) {
    rows.push([Markup.button.callback(mainOffice.name, `dept_${mainOffice.id}`)]);
  }

  const otherDepartments = items.filter((item) => item.id !== "main_office");

  for (let i = 0; i < otherDepartments.length; i += 2) {
    const row = [
      Markup.button.callback(otherDepartments[i].name, `dept_${otherDepartments[i].id}`),
    ];

    if (otherDepartments[i + 1]) {
      row.push(
        Markup.button.callback(
          otherDepartments[i + 1].name,
          `dept_${otherDepartments[i + 1].id}`,
        ),
      );
    }

    rows.push(row);
  }

  return Markup.inlineKeyboard(rows);
}

function getMessageType(message) {
  if (message.text) return "text";
  if (message.photo) return "photo";
  if (message.document) return "document";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video) return "video";
  if (message.video_note) return "video_note";
  return "unsupported";
}

function buildStudentForwardMessage({ department, studentName, studentUsername, senderId, messageType, messageText }) {
  const base =
    "📨 አዲስ የተማሪ መልዕክት\n\n" +
    `📂 ክፍል፦ ${department.name}\n` +
    `👤 ስም፦ ${studentName || "ያልታወቀ"}\n` +
    `🔗 Username፦ ${studentUsername}\n` +
    `🆔 Telegram ID፦ ${senderId}\n\n` +
    `📎 የመልዕክት አይነት፦ ${messageType}\n\n`;

  if (messageText) {
    return `${base}💬 መልዕክት፦\n${messageText}\n\n↩️ ለተማሪው በቀጥታ ለመመለስ፦\nበዚህ መልዕክት ላይ Reply / መልስ ይምረጡ።`;
  }

  return `${base}📎 ሚዲያ ፋይል አስገብቷል።\n\n↩️ ለተማሪው በቀጥታ ለመመለስ፦\nበዚህ መልዕክት ላይ Reply / መልስ ይምረጡ።`;
}

function getStatusForMediaType(type) {
  if (["text", "photo", "document", "voice", "audio", "video", "video_note"].includes(type)) {
    return true;
  }

  return false;
}

async function handleRepresentativeReply(ctx) {
  const { message } = ctx;
  const replyTarget = message.reply_to_message;

  if (!replyTarget) {
    await ctx.reply(getRepresentativeReplyGuidance());
    return true;
  }

  const forwardedMessageId = Number(replyTarget.message_id);
  const relatedMessage = storage.getMessageByForwardedMessageId(forwardedMessageId, Number(ctx.chat.id));

  if (!relatedMessage) {
    await ctx.reply("⚠️ ይህ መልዕክት ከተማሪ የተላከ ተላላኪ መልዕክት አይደለም።");
    return true;
  }

  const replyText = message.text || message.caption || "📩 ምላሽ ተቀብሏል።";

  try {
    await ctx.telegram.sendMessage(
      Number(relatedMessage.student_chat_id),
      `📩 ከደ/ማ/ዩ ግ/ጉባኤ የተላከ ምላሽ፦\n\n${replyText}`,
    );

    storage.updateReplyStatus({
      forwardedMessageId,
      repChatId: Number(ctx.chat.id),
      status: "answered",
    });

    await ctx.reply("✅ ምላሽዎ ለተማሪው በተሳካ ሁኔታ ተልኳል።");
    return true;
  } catch (error) {
    console.error("Reply delivery failed:", error.description || error.message);
    await ctx.reply("❌ ምላሹን ለተማሪው መላክ አልተቻለም።");
    return true;
  }
}

async function handleStudentSubmission(ctx) {
  const senderId = ctx.from.id;
  const message = ctx.message;
  const messageType = getMessageType(message);

  if (storage.isRepresentativeUser(senderId, ctx.from.username)) {
    if (isReplyToForwardedStudentMessage(message)) {
      return handleRepresentativeReply(ctx);
    }

    await ctx.reply(getRepresentativeReplyGuidance());
    return;
  }

  const selectedDepartment = userSelections.get(senderId);
  if (!selectedDepartment) {
    await ctx.reply("ℹ️ መጀመሪያ ክፍል ይምረጡ።");
    await showMainMenu(ctx);
    return;
  }

  if (!getStatusForMediaType(messageType)) {
    await ctx.reply("⚠️ ይህ አይነት መልዕክት አሁን አይደገፍም።\n\nእባክዎ ጽሑፍ፣ ፎቶ፣ ሰነድ ወይም ድምፅ ይምረጡ።");
    return;
  }

  const departmentRepresentativeChatIds = storage.getDepartmentRepresentativeChats(selectedDepartment.id);
  const globalRecipientChatIds = storage.getRepresentativeChatsByUsernames(getGlobalRecipientUsernames());
  const representativeChatIds = Array.from(new Set([
    ...departmentRepresentativeChatIds,
    ...globalRecipientChatIds,
  ]));
  if (!representativeChatIds.length) {
    await ctx.reply(
      "⚠️ ይቅርታ፣ ለዚህ ክፍል የተመዘገበ ተወካይ የለም።\n\n" +
        "እባክዎ ተወካይ እንዲተካ የአስተዳደር ማቀናበሪያውን ያስፈልጋል።",
    );
    return;
  }

  const studentName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  const studentUsername = ctx.from.username ? `@${ctx.from.username}` : "የለውም";
  const textContent = message.text || message.caption || "";

  const baseText = buildStudentForwardMessage({
    department: selectedDepartment,
    studentName,
    studentUsername,
    senderId,
    messageType,
    messageText: textContent,
  });

  let sentCount = 0;

  try {
    for (const repChatId of representativeChatIds) {
      let result;

      if (messageType === "text") {
        result = await ctx.telegram.sendMessage(repChatId, baseText);
      } else {
        const sendOptions = { caption: baseText };
        result = await ctx.telegram.copyMessage(repChatId, ctx.chat.id, message.message_id, sendOptions);
      }

      storage.recordForwardedMessage({
        studentChatId: ctx.chat.id,
        studentUserId: senderId,
        departmentId: selectedDepartment.id,
        departmentName: selectedDepartment.name,
        subDepartmentId: selectedDepartment.id,
        subDepartmentName: selectedDepartment.name,
        repChatId,
        forwardedMessageId: Number(result.message_id),
        originalMessageId: Number(message.message_id),
        messageType,
        messageText: textContent,
      });

      replyMap.set(Number(result.message_id), {
        chatId: ctx.chat.id,
        departmentId: selectedDepartment.id,
        departmentName: selectedDepartment.name,
        repChatId,
      });

      sentCount += 1;
    }

    userSelections.delete(senderId);

    await ctx.reply(
      "🙏 ስለላኩልን ሃሳብ፣ ጥያቄ ወይም አስተያየት ከልብ እናመሰግናለን።\n\n" +
        "📩 መልዕክትዎ ለሚመለከተው ክፍል ደርሶልዎታል።\n\n" +
        "በግቢ ጉባኤው በሚዘጋጅ ልዩ ጉባኤ ላይ ወይም ሌሎች መርሐ ግብራት ላይ  ተገቢው ምላሽ ይሰጣል። ስለሚሰጡን አስተያየት በእግዚአብሔር ስም እናመሰግናለን። 🙏",
    );

    console.log(`✅ Student message forwarded to ${sentCount} representative(s).`);
  } catch (error) {
    console.error("Submission forwarding failed:", error.description || error.message);
    await ctx.reply("❌ መልዕክትዎን መላክ አልተቻለም።\n\nእባክዎ እንደገና ይሞክሩ።");
  }
}

bot.telegram.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "menu", description: "Open the main menu" },
  { command: "cancel", description: "Cancel the current submission" },
]);

bot.command("menu", async (ctx) => {
  await showMainMenu(ctx);
});

bot.hears(["Menu", "Main Menu"], async (ctx) => {
  await showMainMenu(ctx);
});

bot.hears(["✍️ Send Message", "Send Message"], async (ctx) => {
  await showMainMenu(ctx);
});

bot.command("cancel", async (ctx) => {
  userSelections.delete(ctx.from.id);
  await ctx.reply("❌ የመልዕክት ማቅረብ ሂደቱ ተሰርዟል።");
  await showMainMenu(ctx);
});

bot.command("admin", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const stats = storage.getStats();
  const list = stats.byDepartment.map((item) => `${item.department_id}: ${item.count}`).join("\n") || "ምንም መረጃ የለም";

  await ctx.reply(
    "🛠️ አስተዳደር መሳሪያዎች\n\n" +
      "/stats - አጠቃላይ የመልዕክት ሁኔታ\n" +
      "/list_reps - ተወካዮች\n" +
      "/assign_rep <department_id> <username> - ተወካይ መመደብ\n\n" +
      `📊 ድምር: ${stats.total}\n` +
      `✅ የተመለሰ: ${stats.answered}\n` +
      `⏳ ቀርቷል: ${stats.pending}\n\n` +
      `ክፍል በየደረጃ:\n${list}`,
  );
});

bot.command("list_reps", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const rows = [];

  for (const department of departments) {
    const repUsernames = storage.getDepartmentRepresentativeUsernames(department.id);
    rows.push(`${department.name}: ${repUsernames.length ? repUsernames.join(", ") : "የለም"}`);

    if (department.subDepartments) {
      for (const subDepartment of department.subDepartments) {
        const subRepUsernames = storage.getDepartmentRepresentativeUsernames(subDepartment.id);
        rows.push(`${subDepartment.name}: ${subRepUsernames.length ? subRepUsernames.join(", ") : "የለም"}`);
      }
    }
  }

  await ctx.reply(rows.join("\n") || "ምንም ተወካይ አልተመዘገበም።");
});

bot.command("assign_rep", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  if (args.length < 2) {
    return ctx.reply("Use: /assign_rep <department_id> <username>");
  }

  const [departmentId, username] = args;
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return ctx.reply("❌ ትክክለኛ የተወካይ ስም ያስፈልጋል።");
  }

  const rep = storage.findRepresentativeByUsername(normalizedUsername);
  if (!rep) {
    return ctx.reply(
      "⚠️ የተመዘገበ ተወካይ አይደለም።\n\n" +
        "እባክዎ ተወካዩ በ /start አስተካክለው እንዲጀምር ይጠይቁ።",
    );
  }

  storage.assignDepartmentRepresentative({
    departmentId,
    representativeUserId: rep.telegram_user_id,
    username: normalizedUsername,
    chatId: Number(rep.chat_id),
  });

  await ctx.reply(`✅ ${normalizedUsername} ወደ ${departmentId} ተመድቧል።`);
});

bot.command("stats", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const stats = storage.getStats();
  await ctx.reply(
    `📊 አጠቃላይ መልዕክቶች: ${stats.total}\n` +
      `✅ ተመልሷል: ${stats.answered}\n` +
      `⏳ ቀርቷል: ${stats.pending}`,
  );
});

bot.start(async (ctx) => {
  const username = normalizeUsername(ctx.from.username);
  const isAdmin = isAdminUser(ctx);

  if (isAdmin) {
    storage.upsertRepresentative({
      telegramUserId: ctx.from.id,
      chatId: ctx.chat.id,
      username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      isAdmin: true,
    });

    const adminGreeting =
      "✅ አስተዳዳሪ ተገኝተዋል።\n\n" +
      "እባክዎ /admin ን በመጠቀም የግቢ አስተዳደር ማስተካከያዎችን ይጠቀሙ።";

    await ctx.reply(adminGreeting, { reply_markup: buildReplyMenu() });
    return;
  }

  const registeredAsRepresentative = registerRepresentativeIfConfigured(ctx);
  if (registeredAsRepresentative) {
    return ctx.reply(
      "✅ እንኳን ደህና መጡ!\n\n" +
        "እርስዎ እንደ ተወካይ ተመዝግበዋል።\n\n" +
        "📩 የተማሪዎች መልዕክቶች እዚህ ይደርሳሉ።\n\n" +
        "↩️ ለተማሪው መልስ ለመላክ በደረሰዎት መልዕክት ላይ Reply / መልስ ይጠቀሙ።",
      { reply_markup: buildReplyMenu() },
    );
  }

  await ctx.reply(
    "🕊️ እንኳን ወደ ደ/ማ/ዩ/ጉባኤ በደህና መጣችሁ!\n\n" +
      "ለአገልግሎታችን ግብዓት ይሆነን ዘንድ ማንኛውንም ሃሳብ፣ " +
      "አስተያየት እንዲሁም ጥያቄ ማቅረብ ትችላላችሁ።",
    { reply_markup: buildReplyMenu() },
  );

  await showMainMenu(ctx);
});

bot.action(/^dept_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const departmentId = ctx.match[1];
  const department = getDepartmentById(departmentId);

  if (!department) {
    return ctx.reply("❌ የመረጡት ክፍል አልተገኘም።");
  }

  if (department.subDepartments && department.subDepartments.length > 0) {
    const buttons = department.subDepartments.map((subDepartment) => [
      Markup.button.callback(subDepartment.name, `subdept_${subDepartment.id}`),
    ]);

    buttons.push([Markup.button.callback("⬅️ ወደ ዋናው ክፍል ይግቡ ", "back_main")]);

    return ctx.reply(
      `📚 ${department.name}\n\n` + "እባክዎ ንዑስ ክፍሉን ይምረጡ።",
      Markup.inlineKeyboard(buttons),
    );
  }

  await askForMessage(ctx, { id: department.id, name: department.name });
});

bot.action(/^subdept_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subDepartmentId = ctx.match[1];
  const result = getSubDepartmentById(subDepartmentId);

  if (!result) {
    return ctx.reply("❌ የመረጡት ንዑስ ክፍል አልተገኘም።");
  }

  await askForMessage(ctx, {
    id: result.subDepartment.id,
    name: result.subDepartment.name,
  });
});

bot.action("back_main", async (ctx) => {
  await ctx.answerCbQuery();
  userSelections.delete(ctx.from.id);
  await showMainMenu(ctx);
});

bot.on(["text", "photo", "document", "voice", "audio", "video", "video_note"], async (ctx) => {
  await handleStudentSubmission(ctx);
});

bot.catch((error, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, error && (error.description || error.message || error));
});

bot.launch();
console.log("🤖 DMU Gibi Gubaie Telegram Bot is running...");

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
