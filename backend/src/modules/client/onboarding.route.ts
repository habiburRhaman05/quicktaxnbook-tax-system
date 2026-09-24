import express from 'express';

import * as clientController from './client.controller';

const router = express.Router();

// Public - no authentication. A client reaches these from the emailed onboarding link.
router.get('/:token', clientController.getOnboardingLinkInfo);
router.post('/:token/complete', clientController.completeOnboarding);

export default router;
