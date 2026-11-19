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
const adminBroadcastState = new Map();
const adminAssignState = new Map();
// value shape: { step: 'waiting_username' | 'waiting_dept', action: 'assign' | 'remove', username?: string }
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
  userSelections.set(ctx.from.id, { department });
  await ctx.reply(
    `📂 የመረጡት ክፍል፦ ${department.name}\n\n` +
      "✍ እባክዎ ሃሳብዎን፣ ጥያቄዎን ወይም አስተያየትዎን አሁን ይጻፉ።\n\n" +
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

function buildDepartmentAssignKeyboard(action) {
  const prefix = action === 'assign' ? 'assign_dept_' : 'remove_dept_';
  const allItems = [];
  for (const dept of departments) {
    allItems.push({ id: dept.id, name: dept.name });
    if (dept.subDepartments) {
      for (const sub of dept.subDepartments) {
        allItems.push({ id: sub.id, name: sub.name });
      }
    }
  }
  const rows = [];
  for (let i = 0; i < allItems.length; i += 2) {
    const row = [Markup.button.callback(allItems[i].name, `${prefix}${allItems[i].id}`)];
    if (allItems[i + 1]) {
      row.push(Markup.button.callback(allItems[i + 1].name, `${prefix}${allItems[i + 1].id}`));
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
    return `${base}💬 መልዕክት፦\n${messageText}\n\n↩ ለተማሪው በቀጥታ ለመመለስ፦\nበዚህ መልዕክት ላይ Reply / መልስ ይምረጡ።`;
  }
  return `${base}📎 ሚዲያ ፋይል አስገብቷል።\n\n↩ ለተማሪው በቀጥታ ለመመለስ፦\nበዚህ መልዕክት ላይ Reply / መልስ ይምረጡ።`;
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

  const selection = userSelections.get(senderId);
  if (!selection) {
    await ctx.reply("ℹ️ መጀመሪያ ክፍል ይምረጡ።");
    await showMainMenu(ctx);
    return;
  }

  const { department: selectedDepartment } = selection;

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
        "እባክዎ ተወካይ እንዲተካ ለአስተዳደር አቅናባሪው ያመልክቱ።",
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

async function registerBotCommands() {
  await bot.telegram.setMyCommands(
    [
      { command: 'start', description: 'Bot ጀምር' },
      { command: 'menu', description: 'ዋና ማውጫ ክፈት' },
      { command: 'cancel', description: 'ወቅታዊ ምርጫ ሰርዝ' },
    ],
    { scope: { type: 'default' } }
  );

  // Collect admin chat IDs from env AND from the representatives table by username
  const adminChatIdsFromEnv = getAdminChatIds();
  const adminChatIdsFromDb = getAdminUsernames()
    .map((u) => storage.findRepresentativeByUsername(u))
    .filter(Boolean)
    .map((r) => Number(r.chat_id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const adminChatIds = Array.from(new Set([...adminChatIdsFromEnv, ...adminChatIdsFromDb]));

  for (const chatId of adminChatIds) {
    try {
      await bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Bot ጀምር' },
          { command: 'menu', description: 'ዋና ማውጫ ክፈት' },
          { command: 'cancel', description: 'ወቅታዊ ምርጫ ሰርዝ' },
          { command: 'admin', description: 'አስተዳደር ፓነል' },
          { command: 'stats', description: 'የመልዕክት ስታቲስቲክስ' },
          { command: 'list_reps', description: 'ተወካዮች ዝርዝር' },
          { command: 'assign_rep', description: 'ተወካይ መድብ' },
          { command: 'remove_rep', description: 'ተወካይ አስወግድ' },
          { command: 'list_departments', description: 'ክፍሎች ዝርዝር' },
          { command: 'broadcast', description: 'ለተማሪዎች አስታወቅ' },
          { command: 'broadcast_reps', description: 'ለተወካዮች አስታወቅ' },
        ],
        { scope: { type: 'chat', chat_id: chatId } }
      );
    } catch (err) {
      console.error(`Failed to set commands for admin chatId ${chatId}:`, err.description || err.message);
    }
  }
}

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
    return ctx.reply('⚠️ እርስዎ አስተዳዳሪ አይደሉም።');
  }

  await ctx.reply(
    '🛠️ የደ/ማ/ዩ ግቢ ጉባኤ አስተዳደር ፓነል',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 ስታቲስቲክስ', 'admin_stats'),
        Markup.button.callback('👥 ተወካዮች', 'admin_list_reps'),
      ],
      [
        Markup.button.callback('📋 ክፍሎች', 'admin_list_depts'),
        Markup.button.callback('📢 ለተማሪዎች ላክ', 'admin_broadcast_students'),
      ],
      [
        Markup.button.callback('📣 ለተወካዮች ላክ', 'admin_broadcast_reps'),
      ],
    ])
  );
});

bot.action('admin_stats', async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  const stats = storage.getStats();
  await ctx.reply(
    `📊 አጠቃላይ መልዕክቶች: ${stats.total}\n` +
    `✅ ተመልሷል: ${stats.answered}\n` +
    `⏳ ቀርቷል: ${stats.pending}`
  );
});

bot.action('admin_list_reps', async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  const rows = [];
  for (const department of departments) {
    const repUsernames = storage.getDepartmentRepresentativeUsernames(department.id);
    rows.push(`${department.name}: ${repUsernames.length ? repUsernames.join(', ') : 'የለም'}`);
    if (department.subDepartments) {
      for (const subDepartment of department.subDepartments) {
        const subRepUsernames = storage.getDepartmentRepresentativeUsernames(subDepartment.id);
        rows.push(`${subDepartment.name}: ${subRepUsernames.length ? subRepUsernames.join(', ') : 'የለም'}`);
      }
    }
  }
  await ctx.reply(rows.join('\n') || 'ምንም ተወካይ አልተመዘገበም።');
});

bot.action('admin_list_depts', async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  const lines = ['📋 የክፍሎች ዝርዝር\n'];
  for (const dept of departments) {
    lines.push(`🔑 ${dept.id} — ${dept.name}`);
    if (dept.subDepartments) {
      for (const sub of dept.subDepartments) {
        lines.push(`🔑 ${sub.id} — ${sub.name}`);
      }
    }
  }
  await ctx.reply(lines.join('\n'));
});

bot.action('admin_broadcast_students', async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  adminBroadcastState.set(ctx.from.id, 'students');
  await ctx.reply('📢 ለተማሪዎች የሚላከውን መልዕክት ይጻፉ፡');
});

bot.action('admin_broadcast_reps', async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  adminBroadcastState.set(ctx.from.id, 'reps');
  await ctx.reply('📣 ለተወካዮች የሚላከውን መልዕክት ይጻፉ፡');
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

bot.command('assign_rep', async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply('⚠️ እርስዎ አስተዳዳሪ አይደሉም።');
  }

  const args = (ctx.message.text || '').split(/\s+/).slice(1);

  // Mode C — both args (old behavior): /assign_rep <dept_id> <username>
  if (args.length >= 2) {
    const [departmentId, username] = args;
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return ctx.reply('❌ ትክክለኛ የተወካይ ስም ያስፈልጋል።');
    }
    const rep = storage.findRepresentativeByUsername(normalizedUsername);
    if (!rep) {
      return ctx.reply(
        '⚠️ የተመዘገበ ተወካይ አይደለም።\n\nእባክዎ ተወካዩ በ /start አስተካክለው እንዲጀምር ይጠይቁ።',
      );
    }
    storage.assignDepartmentRepresentative({
      departmentId,
      representativeUserId: rep.telegram_user_id,
      username: normalizedUsername,
      chatId: Number(rep.chat_id),
    });
    return ctx.reply(`✅ ${normalizedUsername} ወደ ${departmentId} ተመድቧል።`);
  }

  // Mode B — username only: /assign_rep <username>
  if (args.length === 1) {
    const normalizedUsername = normalizeUsername(args[0]);
    if (!normalizedUsername) {
      return ctx.reply('❌ ትክክለኛ የተወካይ ስም ያስፈልጋል።');
    }
    adminAssignState.set(ctx.from.id, { step: 'waiting_dept', action: 'assign', username: normalizedUsername });
    return ctx.reply(
      `👤 ተወካይ፦ ${normalizedUsername}\n\nክፍሉን ይምረጡ:`,
      buildDepartmentAssignKeyboard('assign'),
    );
  }

  // Mode A — no args: /assign_rep
  adminAssignState.set(ctx.from.id, { step: 'waiting_username', action: 'assign' });
  return ctx.reply('👤 ተወካይ ሊያደርጉት የፈለጉትን የግቢ ጉባኤ አባል የቴሌግራም username ያስገቡ (@ ሳያስፈልግ)፡');
});

bot.command("list_departments", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const lines = ["📋 የክፍሎች ዝርዝር\n"];
  for (const dept of departments) {
    lines.push(`🔑 ${dept.id} — ${dept.name}`);
    if (dept.subDepartments) {
      for (const sub of dept.subDepartments) {
        lines.push(`🔑 ${sub.id} — ${sub.name}`);
      }
    }
  }

  await ctx.reply(lines.join("\n"));
});

bot.command('remove_rep', async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply('⚠️ እርስዎ አስተዳዳሪ አይደሉም።');
  }

  const args = (ctx.message.text || '').split(/\s+/).slice(1);

  // Mode C — both args (old behavior): /remove_rep <dept_id> <username>
  if (args.length >= 2) {
    const [departmentId, rawUsername] = args;
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return ctx.reply('❌ ትክክለኛ የተወካይ ስም ያስፈልጋል።');
    }
    const info = storage.removeDepartmentRepresentative({ departmentId, username });
    if (info.changes > 0) {
      return ctx.reply(`✅ ${username} ከ${departmentId} ተወካይነት ተወግዷል።`);
    } else {
      return ctx.reply('⚠️ ያቀረቡት ተወካይ ወይም ክፍል አልተገኘም።');
    }
  }

  // Mode B — username only: /remove_rep <username>
  if (args.length === 1) {
    const normalizedUsername = normalizeUsername(args[0]);
    if (!normalizedUsername) {
      return ctx.reply('❌ ትክክለኛ የተወካይ ስም ያስፈልጋል።');
    }
    adminAssignState.set(ctx.from.id, { step: 'waiting_dept', action: 'remove', username: normalizedUsername });
    return ctx.reply(
      `👤 ተወካይ፦ ${normalizedUsername}\n\nክፍሉን ይምረጡ:`,
      buildDepartmentAssignKeyboard('remove'),
    );
  }

  // Mode A — no args: /remove_rep
  adminAssignState.set(ctx.from.id, { step: 'waiting_username', action: 'remove' });
  return ctx.reply('👤 ከተወካይነት ሊያስወግዱት የፈለጉትን የግቢ ጉባኤ አባል የቴሌግራም username ያስገቡ (@ ሳያስፈልግ)፡');
});

bot.action(/^assign_dept_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  const departmentId = ctx.match[1];
  const state = adminAssignState.get(ctx.from.id);
  if (!state || state.action !== 'assign') {
    return ctx.reply('⚠️ ምርጫ ጊዜው አልፎበታል። /assign_rep ን እንደገና ይሞክሩ።');
  }
  const { username } = state;
  adminAssignState.delete(ctx.from.id);

  // Resolve department name
  let deptName = departmentId;
  const mainDept = getDepartmentById(departmentId);
  if (mainDept) {
    deptName = mainDept.name;
  } else {
    const subResult = getSubDepartmentById(departmentId);
    if (subResult) deptName = subResult.subDepartment.name;
  }

  const rep = storage.findRepresentativeByUsername(username);
  if (!rep) {
    return ctx.reply(
      `⚠️ ${username} የተመዘገበ ተወካይ አይደለም።\n\nእባክዎ ተወካዩ በ /start አስተካክለው እንዲጀምር ይጠይቁ።`,
    );
  }
  storage.assignDepartmentRepresentative({
    departmentId,
    representativeUserId: rep.telegram_user_id,
    username,
    chatId: Number(rep.chat_id),
  });
  await ctx.reply(`✅ ${username} ለ ${deptName} ተመድቧል።`);
});

bot.action(/^remove_dept_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx)) {
    await ctx.answerCbQuery('⚠️ ተፈቃጅ አይደሉም።');
    return;
  }
  await ctx.answerCbQuery();
  const departmentId = ctx.match[1];
  const state = adminAssignState.get(ctx.from.id);
  if (!state || state.action !== 'remove') {
    return ctx.reply('⚠️ ምርጫ ጊዜው አልፎበታል። /remove_rep ን እንደገና ይሞክሩ።');
  }
  const { username } = state;
  adminAssignState.delete(ctx.from.id);

  // Resolve department name
  let deptName = departmentId;
  const mainDept = getDepartmentById(departmentId);
  if (mainDept) {
    deptName = mainDept.name;
  } else {
    const subResult = getSubDepartmentById(departmentId);
    if (subResult) deptName = subResult.subDepartment.name;
  }

  const info = storage.removeDepartmentRepresentative({ departmentId, username });
  if (info.changes === 0) {
    return ctx.reply(`⚠️ ${username} በ ${deptName} ውስጥ አልተገኘም።`);
  }
  await ctx.reply(`✅ ${username} ከ ${deptName} ተወግዷል።`);
});

bot.command("broadcast", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply("⚠️ እርስዎ አስተዳዳሪ አይደሉም።");
  }

  const fullText = ctx.message.text || "";
  const broadcastBody = fullText.replace(/^\/broadcast\s*/, "").trim();

  if (!broadcastBody) {
    return ctx.reply("⚠️ አጠቃቀም: /broadcast <መልዕክት>");
  }

  const broadcastText = `📢 ከደ/ማ/ዩ ግቢ ጉባኤ ማስታወቂያ\n\n${broadcastBody}`;
  const chatIds = storage.getUniqueStudentChatIds();

  let successCount = 0;
  let failCount = 0;

  for (const chatId of chatIds) {
    try {
      await ctx.telegram.sendMessage(chatId, broadcastText);
      successCount += 1;
    } catch (err) {
      console.error(`Broadcast failed for chatId ${chatId}:`, err.description || err.message);
      failCount += 1;
    }
  }

  await ctx.reply(`✅ ማስታወቂያ ተልኳል። ደርሷቸዋል: ${successCount} | አልደረሰም: ${failCount}`);
});

bot.command("broadcast_reps", async (ctx) => {
  if (!isAdminUser(ctx)) {
    return ctx.reply('⚠️ እርስዎ አስተዳዳሪ አይደሉም።');
  }

  const fullText = ctx.message.text || '';
  const broadcastBody = fullText.replace(/^\/broadcast_reps\s*/, '').trim();

  if (!broadcastBody) {
    return ctx.reply('⚠️ አጠቃቀም: /broadcast_reps <መልዕክት>');
  }

  const broadcastText = `📣 የደ/ማ/ዩ ግቢ ጉባኤ ዋናው ጽ/ቤት ለተወካዮች ማስታወቂያ\n\n${broadcastBody}`;
  const chatIds = storage.getRepresentativeChatIds();

  let successCount = 0;
  let failCount = 0;

  for (const chatId of chatIds) {
    try {
      await ctx.telegram.sendMessage(chatId, broadcastText);
      successCount += 1;
    } catch (err) {
      console.error(`Broadcast to rep failed for chatId ${chatId}:`, err.description || err.message);
      failCount += 1;
    }
  }

  await ctx.reply(`✅ ማስታወቂያ ለተወካዮች ተልኳል። ደርሷቸዋል: ${successCount} | አልደረሰም: ${failCount}`);
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
      "👇 /admin ን ተጫኑ የአስተዳደር ፓነሉን ለመክፈት።";

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
      "ለግቢ ጉባኤያችን አገልግሎት እና ለኦርቶዶክሳዊ ህብረታችን ግብዓት  ይሆነን ዘንድ ማንኛውንም ሃሳብ፣ " +
      "አስተያየት እንዲሁም ጥያቄ ማቅረብ ትችላላችሁ። ስለሚሰጡን አስተያየት በእግዚአብሔር ስም እናመሰግናለን 🙏",
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
  // Admin assign/remove state flow
  if (adminAssignState.has(ctx.from.id) && isAdminUser(ctx)) {
    const state = adminAssignState.get(ctx.from.id);
    if (state.step === 'waiting_username') {
      const rawInput = ctx.message.text || '';
      const normalizedUsername = normalizeUsername(rawInput.trim());
      if (!normalizedUsername) {
        await ctx.reply('❌ ትክክለኛ የቴሌግራም username ያስፈልጋል። እባክዎ እንደገና ይሞክሩ።');
        return;
      }
      adminAssignState.set(ctx.from.id, { step: 'waiting_dept', action: state.action, username: normalizedUsername });
      await ctx.reply(
        `👤 ተወካይ፦ ${normalizedUsername}\n\nክፍሉን ይምረጡ:`,
        buildDepartmentAssignKeyboard(state.action),
      );
    }
    return;
  }

  // Admin broadcast state flow
  if (adminBroadcastState.has(ctx.from.id) && isAdminUser(ctx)) {
    const broadcastTarget = adminBroadcastState.get(ctx.from.id);
    adminBroadcastState.delete(ctx.from.id);
    const broadcastBody = ctx.message.text || ctx.message.caption || '';

    if (!broadcastBody) {
      await ctx.reply('⚠️ ባዶ መልዕክት ተቀብሏል። እባክዎ ጽሑፍ ያስገቡ።');
      return;
    }

    if (broadcastTarget === 'students') {
      const broadcastText = `📢 ከደ/ማ/ዩ ግቢ ጉባኤ ማስታወቂያ\n\n${broadcastBody}`;
      const chatIds = storage.getUniqueStudentChatIds();
      let successCount = 0;
      let failCount = 0;
      for (const chatId of chatIds) {
        try {
          await ctx.telegram.sendMessage(chatId, broadcastText);
          successCount += 1;
        } catch (err) {
          console.error(`Broadcast failed for chatId ${chatId}:`, err.description || err.message);
          failCount += 1;
        }
      }
      await ctx.reply(`✅ ማስታወቂያ ለተማሪዎች ተልኳል። ደርሷቸዋል: ${successCount} | አልደረሰም: ${failCount}`);
    } else if (broadcastTarget === 'reps') {
      const broadcastText = `📣 የደ/ማ/ዩ ግቢ ጉባኤ ዋናው ጽ/ቤት ለተወካዮች ማስታወቂያ\n\n${broadcastBody}`;
      const chatIds = storage.getRepresentativeChatIds();
      let successCount = 0;
      let failCount = 0;
      for (const chatId of chatIds) {
        try {
          await ctx.telegram.sendMessage(chatId, broadcastText);
          successCount += 1;
        } catch (err) {
          console.error(`Broadcast to rep failed for chatId ${chatId}:`, err.description || err.message);
          failCount += 1;
        }
      }
      await ctx.reply(`✅ ማስታወቂያ ለተወካዮች ተልኳል። ደርሷቸዋል: ${successCount} | አልደረሰም: ${failCount}`);
    }

    return;
  }

  await handleStudentSubmission(ctx);
});

bot.catch((error, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, error && (error.description || error.message || error));
});

bot.launch();
console.log("🤖 DMU Gibi Gubaie Telegram Bot is running...");
registerBotCommands().catch(console.error);

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
