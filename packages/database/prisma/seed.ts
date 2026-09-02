/**
 * Signara database seed.
 *
 * Seeds:
 *  - RBAC: system roles + full permission catalog
 *  - Billing: the four subscription plans
 *  - Demo: an organization, its default workspace, and an admin user
 *
 * Run: `npm run db:seed` (workspace @signara/database)
 * Safe to re-run (idempotent, uses upserts).
 */
import { PrismaClient, MembershipRole, PlatformRole, PlanCode } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{ code: string; description: string; category: string }> = [
  // Organizations
  { code: 'organizations.read', description: 'View organization profile and settings', category: 'organizations' },
  { code: 'organizations.update', description: 'Update organization profile and branding', category: 'organizations' },
  { code: 'organizations.manage', description: 'Manage organization lifecycle and members', category: 'organizations' },
  // Workspaces & teams
  { code: 'workspaces.manage', description: 'Create and manage workspaces', category: 'workspaces' },
  { code: 'teams.manage', description: 'Create and manage teams and team membership', category: 'workspaces' },
  // Members
  { code: 'members.invite', description: 'Invite members to the organization', category: 'members' },
  { code: 'members.manage', description: 'Change member roles and remove members', category: 'members' },
  // Documents
  { code: 'documents.create', description: 'Upload and create documents', category: 'documents' },
  { code: 'documents.read', description: 'View documents', category: 'documents' },
  { code: 'documents.update', description: 'Edit documents and metadata', category: 'documents' },
  { code: 'documents.delete', description: 'Delete or void documents', category: 'documents' },
  { code: 'documents.download', description: 'Download original and signed documents', category: 'documents' },
  { code: 'documents.versions', description: 'View and restore document versions', category: 'documents' },
  // Templates
  { code: 'templates.create', description: 'Create templates', category: 'templates' },
  { code: 'templates.read', description: 'View templates', category: 'templates' },
  { code: 'templates.update', description: 'Edit templates', category: 'templates' },
  { code: 'templates.delete', description: 'Delete templates', category: 'templates' },
  // Signing
  { code: 'signing.send', description: 'Create and send signing requests', category: 'signing' },
  { code: 'signing.read', description: 'View signing requests and events', category: 'signing' },
  { code: 'signing.cancel', description: 'Cancel or void signing requests', category: 'signing' },
  { code: 'signing.remind', description: 'Send reminders to signers', category: 'signing' },
  { code: 'signing.certificateSign', description: 'Apply a certificate-backed signature', category: 'signing' },
  // Certificates
  { code: 'certificates.read', description: 'View certificates and verification results', category: 'certificates' },
  { code: 'certificates.manage', description: 'Import, provision, revoke, and manage certificates', category: 'certificates' },
  // Audit
  { code: 'audit.read', description: 'View audit logs', category: 'audit' },
  { code: 'audit.export', description: 'Export audit logs and evidence reports', category: 'audit' },
  // Billing
  { code: 'billing.read', description: 'View billing account and invoices', category: 'billing' },
  { code: 'billing.manage', description: 'Manage subscriptions, payment methods, coupons', category: 'billing' },
  // API keys
  { code: 'apikeys.manage', description: 'Create and revoke API keys', category: 'apikeys' },
  // Notifications
  { code: 'notifications.read', description: 'View notifications', category: 'notifications' },
  // Administration (platform-wide)
  { code: 'admin.platform', description: 'Platform administration (all tenants)', category: 'admin' },
  { code: 'admin.monitoring', description: 'View platform monitoring and metrics', category: 'admin' },
];

/** Which permission codes each system Role gets. */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  ORGANIZATION_OWNER: Object.keys(Object.fromEntries(PERMISSIONS.map((p) => [p.code, true]))),
  ADMINISTRATOR: Object.keys(Object.fromEntries(PERMISSIONS.map((p) => [p.code, true]))),
  MANAGER: [
    'documents.create',
    'documents.read',
    'documents.update',
    'documents.download',
    'documents.versions',
    'templates.create',
    'templates.read',
    'templates.update',
    'signing.send',
    'signing.read',
    'signing.cancel',
    'signing.remind',
    'signing.certificateSign',
    'certificates.read',
    'notifications.read',
  ],
  AUDITOR: ['documents.read', 'signing.read', 'audit.read', 'audit.export'],
  USER: ['documents.create', 'documents.read', 'documents.download', 'templates.read', 'signing.read', 'signing.certificateSign', 'certificates.read', 'notifications.read'],
};

const PLANS: Array<{ code: PlanCode; name: string; priceMonthly: number; priceYearly: number; features: unknown }> = [
  {
    code: PlanCode.COMMUNITY,
    name: 'Community',
    priceMonthly: 0,
    priceYearly: 0,
    features: { seats: 1, documents: 100, storageBytes: 5_000_000_000, ai: false, api: true, audit: true, branding: false },
  },
  {
    code: PlanCode.PROFESSIONAL,
    name: 'Professional',
    priceMonthly: 1200, // cents ($12)
    priceYearly: 12000,
    features: { seats: 5, documents: 1000, storageBytes: 50_000_000_000, ai: true, api: true, audit: true, branding: true },
  },
  {
    code: PlanCode.BUSINESS,
    name: 'Business',
    priceMonthly: 4900, // cents ($49)
    priceYearly: 49000,
    features: { seats: 25, documents: 10000, storageBytes: 250_000_000_000, ai: true, api: true, audit: true, branding: true, saml: true },
  },
  {
    code: PlanCode.ENTERPRISE,
    name: 'Enterprise',
    priceMonthly: 0, // custom pricing
    priceYearly: 0,
    features: { seats: -1, documents: -1, storageBytes: -1, ai: true, api: true, audit: true, branding: true, saml: true, scim: true, sla: true },
  },
];

async function seedPermissions() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code: p.code }, update: p, create: p });
  }
}

async function seedRoles() {
  for (const [name, codes] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.role.upsert({
      where: { name },
      update: { isSystem: true },
      create: { name, isSystem: true, scope: 'SYSTEM', description: `System role: ${name.replaceAll('_', ' ').toLowerCase()}` },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { name } });
    const permissionIds = (
      await prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true } })
    ).map((p) => p.id);
    for (const permissionId of permissionIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
}

async function seedPlans() {
  for (let i = 0; i < PLANS.length; i++) {
    const plan = PLANS[i];
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: { name: plan.name, priceMonthly: plan.priceMonthly, priceYearly: plan.priceYearly, features: plan.features as object, isActive: true },
      create: { code: plan.code, name: plan.name, priceMonthly: plan.priceMonthly, priceYearly: plan.priceYearly, features: plan.features as object, sortOrder: i },
    });
  }
}

async function seedDemo() {
  const demoEmail = process.env.SIGNARA_DEMO_EMAIL ?? 'admin@signara.local';
  const demoPasswordNote = 'Authentication is delegated to Authentik (OIDC). Provision the demo user in Authentik with the same email.';

  const user = await prisma.user.upsert({
    where: { email: demoEmail },
    update: { platformRole: PlatformRole.PLATFORM_ADMIN, status: 'ACTIVE', emailVerifiedAt: new Date() },
    create: {
      email: demoEmail,
      firstName: 'Signara',
      lastName: 'Admin',
      displayName: 'Signara Admin',
      platformRole: PlatformRole.PLATFORM_ADMIN,
      emailVerifiedAt: new Date(),
    },
  });

  const org = await prisma.organization.upsert({
    where: { slug: 'signara-demo' },
    update: { status: 'ACTIVE' },
    create: { name: 'Signara Demo', slug: 'signara-demo', status: 'ACTIVE' },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: MembershipRole.OWNER },
    create: { organizationId: org.id, userId: user.id, role: MembershipRole.OWNER },
  });

  const defaultWorkspace = await prisma.workspace.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: 'default' } },
    update: {},
    create: { organizationId: org.id, name: 'Default Workspace', slug: 'default', isDefault: true, createdById: user.id },
  });

  await prisma.billingAccount.upsert({
    where: { organizationId: org.id },
    update: {},
    create: { organizationId: org.id, plan: PlanCode.COMMUNITY },
  });

  console.log('Seeded demo tenant:');
  console.log(`  Organization: ${org.name} (${org.slug})`);
  console.log(`  Workspace:    ${defaultWorkspace.name}`);
  console.log(`  User:         ${user.email} (${user.platformRole})`);
  console.log(`  Note:         ${demoPasswordNote}`);
}

async function main() {
  await seedPermissions();
  await seedRoles();
  await seedPlans();
  await seedDemo();
  console.log('Seed complete ✓');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());