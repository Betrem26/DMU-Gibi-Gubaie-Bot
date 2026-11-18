require("dotenv").config();

const DEFAULT_REPRESENTATIVES = {
  main_office: ["Jph2126", "Eth1021"],
  education: ["Jph2126", "Eth1021"],
  educational_literature: ["Jph2126", "Eth1021"],
  hymn: ["Jph2126", "Eth1021"],
  profession: ["Jph2126", "Eth1021"],
  member_care: ["Jph2126", "Eth1021"],
  language: ["Jph2126", "Eth1021"],
  development: ["Jph2126", "Eth1021"],
  coordination: ["Jph2126", "Eth1021"],
};

const GLOBAL_RECIPIENT_USERNAMES = ["Jph2126", "Eth1021"];

function normalizeUsername(value) {
  if (!value) return "";
  return String(value).replace(/^@/, "").trim().toLowerCase();
}

function readJsonConfig(rawValue) {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function mergedDepartmentConfig() {
  const envConfig = readJsonConfig(process.env.DEPARTMENT_REPRESENTATIVES);
  const fallbackTestRep = normalizeUsername(process.env.TEST_REP_USERNAME);

  const merged = { ...DEFAULT_REPRESENTATIVES };

  if (fallbackTestRep) {
    for (const departmentId of Object.keys(merged)) {
      merged[departmentId] = Array.from(
        new Set([...(merged[departmentId] || []), fallbackTestRep]),
      );
    }
  }

  for (const [departmentId, reps] of Object.entries(envConfig || {})) {
    const normalized = (Array.isArray(reps) ? reps : []).map(normalizeUsername).filter(Boolean);
    if (normalized.length > 0) merged[departmentId] = normalized;
  }

  return merged;
}

function getDepartmentRepUsernames(departmentId) {
  const departmentKey = String(departmentId || "").trim();
  const config = mergedDepartmentConfig();
  const names = config[departmentKey] || [];

  return Array.from(new Set(names.map(normalizeUsername).filter(Boolean)));
}

function getDepartmentIdsForRepresentative(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return [];

  const results = [];
  const config = mergedDepartmentConfig();

  for (const [departmentId, reps] of Object.entries(config)) {
    if ((reps || []).map(normalizeUsername).includes(normalized)) {
      results.push(departmentId);
    }
  }

  return results;
}

function getAdminUsernames() {
  const raw = process.env.ADMIN_USERNAMES || "";
  return Array.from(new Set([
    "jph2126",
    ...raw
      .split(",")
      .map(normalizeUsername)
      .filter(Boolean),
  ]));
}

function getAdminChatIds() {
  const raw = process.env.ADMIN_IDS || "";
  return raw
    .split(",")
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function getGlobalRecipientUsernames() {
  return GLOBAL_RECIPIENT_USERNAMES.map(normalizeUsername);
}

module.exports = {
  normalizeUsername,
  getDepartmentRepUsernames,
  getDepartmentIdsForRepresentative,
  getAdminUsernames,
  getAdminChatIds,
  getGlobalRecipientUsernames,
  mergedDepartmentConfig,
};
