const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeUsername,
  getDepartmentRepUsernames,
  getDepartmentIdsForRepresentative,
  getAdminUsernames,
  getAdminChatIds,
} = require("../src/rep-config");

const storage = require("../src/storage");

test("normalizeUsername strips @ and lowercases names", () => {
  assert.equal(normalizeUsername("@Jph2126"), "jph2126");
  assert.equal(normalizeUsername("  ADMIN  "), "admin");
});

test("department representative config returns configured users", () => {
  process.env.TEST_REP_USERNAME = "Jph2126";
  assert.deepEqual(getDepartmentRepUsernames("main_office"), ["jph2126"]);
});

test("department lookup finds all configured departments for a username", () => {
  process.env.DEPARTMENT_REPRESENTATIVES = JSON.stringify({
    main_office: ["Jph2126"],
    education: ["rep1", "Jph2126"],
  });

  assert.deepEqual(
    getDepartmentIdsForRepresentative("jph2126").sort(),
    [
      "coordination",
      "development",
      "education",
      "educational_literature",
      "hymn",
      "language",
      "main_office",
      "member_care",
      "profession",
    ].sort(),
  );
});

test("admin usernames and chat IDs are parsed safely", () => {
  process.env.ADMIN_USERNAMES = "Admin1, admin2";
  process.env.ADMIN_IDS = "1001, 2002";

  assert.deepEqual(getAdminUsernames(), ["jph2126", "admin1", "admin2"]);
  assert.deepEqual(getAdminChatIds(), [1001, 2002]);
});

test("storage can create and query representative records", () => {
  storage.upsertRepresentative({
    telegramUserId: 777000,
    chatId: 555000,
    username: "RepTester",
    firstName: "Rep",
    lastName: "Tester",
    isAdmin: true,
  });

  const record = storage.findRepresentativeByUserId(777000);
  assert.ok(record);
  assert.equal(record.username, "reptester");
  assert.equal(record.chat_id, 555000);
});

test("storage can attach a department to a representative", () => {
  storage.assignDepartmentRepresentative({
    departmentId: "main_office",
    representativeUserId: 777000,
    username: "reptester",
    chatId: 555000,
  });

  const chats = storage.getDepartmentRepresentativeChats("main_office");
  assert.ok(chats.includes(555000));
});
