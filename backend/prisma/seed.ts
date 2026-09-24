import { PrismaClient } from '@prisma/client';

import config from '../src/config/config';
import { hashSecret } from '../src/shared/utils/encryption';

const prisma = new PrismaClient();

async function main() {
  const email = config.platformOwner.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Platform Owner already exists (${email}) - nothing to do.`);
    return;
  }

  const passwordHash = await hashSecret(config.platformOwner.password);

  const owner = await prisma.user.create({
    data: {
      email,
      firstName: config.platformOwner.firstName,
      lastName: config.platformOwner.lastName,
      displayName: `${config.platformOwner.firstName} ${config.platformOwner.lastName}`,
      passwordHash,
      accountRole: 'PLATFORM_OWNER',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  console.log('Platform Owner created:');
  console.log(`  email:    ${owner.email}`);
  console.log(`  password: ${config.platformOwner.password}`);
  console.log('Store this password somewhere safe - it will not be shown again by this script.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
