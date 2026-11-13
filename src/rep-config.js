require("dotenv").config();

const DEFAULT_REPRESENTATIVES = {
  main_office: ["Eth1021"],
  education: ["Eth1021"],
  educational_literature: ["Eth1021"],
  hymn: ["Eth1021"],
  profession: ["Eth1021"],
  member_care: ["Eth1021"],
  language: ["Eth1021"],
  development: ["Eth1021"],
  coordination: ["Eth1021"],
};

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
  return raw
    .split(",")
    .map(normalizeUsername)
    .filter(Boolean);
}

function getAdminChatIds() {
  const raw = process.env.ADMIN_IDS || "";
  return raw
    .split(",")
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

module.exports = {
  normalizeUsername,
  getDepartmentRepUsernames,
  getDepartmentIdsForRepresentative,
  getAdminUsernames,
  getAdminChatIds,
  mergedDepartmentConfig,
};
