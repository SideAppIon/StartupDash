// Справочник ролей платформы.
// Эксперт, куратор, ментор, буст-партнёр и наблюдатель — одна группа с одинаковыми
// правами, отличаются только названием. Исключение: наблюдателя нельзя пригласить в проект,
// и сам он не может подать заявку в проект.
const { queryOne } = require('../db');

const EXPERT_ROLES = ['expert', 'curator', 'mentor', 'boost_partner', 'observer'];
const ALL_ROLES    = ['user', 'startup', ...EXPERT_ROLES, 'admin', 'moderator', 'support'];

// Роли, которые при регистрации проходят ручную модерацию.
// До одобрения человек работает как наблюдатель.
// Эксперт / куратор / ментор прикладывают сертификат, буст-партнёр (человек из бизнеса) — ИНН.
const MODERATED_ROLES = ['expert', 'curator', 'mentor', 'boost_partner'];
const INN_ROLES       = ['boost_partner'];
// Роли, которые можно выбрать при регистрации
const SELF_REGISTER_ROLES = ['user', 'startup', ...EXPERT_ROLES];

const isExpertRole   = (role) => EXPERT_ROLES.includes(role);
const canJoinProject = (role) => role !== 'observer';
const needsModeration = (role) => MODERATED_ROLES.includes(role);
const needsInn        = (role) => INN_ROLES.includes(role);

// Проверка ИНН по контрольным цифрам: 10 цифр — юрлицо, 12 — ИП / физлицо
function isValidInn(inn) {
  const s = String(inn || '');
  if (!/^(\d{10}|\d{12})$/.test(s)) return false;
  const d = s.split('').map(Number);
  const check = (coefs) => coefs.reduce((sum, c, i) => sum + c * d[i], 0) % 11 % 10;
  if (d.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10]
      && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

// Для вставки в SQL: 'expert','curator',...
const EXPERT_ROLES_SQL = EXPERT_ROLES.map(r => `'${r}'`).join(',');
const ALL_ROLES_SQL    = ALL_ROLES.map(r => `'${r}'`).join(',');

// Приводим CHECK-констрейнт users.role к актуальному списку ролей
// (в проде он мог быть создан без новых ролей; автораннера миграций нет)
let roleConstraintEnsured = false;
async function ensureRoleConstraint() {
  if (roleConstraintEnsured) return;
  try {
    await queryOne('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
    await queryOne(`ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN (${ALL_ROLES_SQL}))`);
    roleConstraintEnsured = true;
  } catch (e) {
    console.error('ensureRoleConstraint error:', e.message);
  }
}

module.exports = {
  EXPERT_ROLES, ALL_ROLES, MODERATED_ROLES, SELF_REGISTER_ROLES,
  EXPERT_ROLES_SQL, ALL_ROLES_SQL,
  isExpertRole, canJoinProject, needsModeration, needsInn, isValidInn,
  ensureRoleConstraint,
};
