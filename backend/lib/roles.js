// Справочник ролей платформы.
// Эксперт, куратор, ментор и наблюдатель — одна группа с одинаковыми правами,
// отличаются только названием. Исключение: наблюдателя нельзя пригласить в проект,
// и сам он не может подать заявку в проект.
const { queryOne } = require('../db');

const EXPERT_ROLES = ['expert', 'curator', 'mentor', 'observer'];
const ALL_ROLES    = ['user', 'startup', ...EXPERT_ROLES, 'admin', 'moderator', 'support'];

// Роли, которые при регистрации проходят ручную модерацию (с сертификатом).
// До одобрения человек работает как наблюдатель.
const MODERATED_ROLES = ['expert', 'curator', 'mentor'];
// Роли, которые можно выбрать при регистрации
const SELF_REGISTER_ROLES = ['user', 'startup', ...EXPERT_ROLES];

const isExpertRole   = (role) => EXPERT_ROLES.includes(role);
const canJoinProject = (role) => role !== 'observer';
const needsModeration = (role) => MODERATED_ROLES.includes(role);

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
  isExpertRole, canJoinProject, needsModeration,
  ensureRoleConstraint,
};
