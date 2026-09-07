-- ==========================================================================
-- Signara — backfill membership roleId
-- Memberships created before RBAC wiring stored only the MembershipRole enum
-- (`role`), leaving `roleId` NULL. Permissions are read from
-- `roleRef.permissions`, so those memberships resolved to an empty permission
-- set and every @Permissions() route returned 403 for non-platform-admins.
-- Point each membership at its seeded system Role by name.
-- ==========================================================================

UPDATE "Membership" AS m
SET "roleId" = r."id"
FROM "Role" AS r
WHERE m."roleId" IS NULL
  AND r."name" = CASE m."role"
    WHEN 'OWNER' THEN 'ORGANIZATION_OWNER'
    WHEN 'ADMIN' THEN 'ADMINISTRATOR'
    WHEN 'MANAGER' THEN 'MANAGER'
    WHEN 'AUDITOR' THEN 'AUDITOR'
    WHEN 'MEMBER' THEN 'USER'
  END;
