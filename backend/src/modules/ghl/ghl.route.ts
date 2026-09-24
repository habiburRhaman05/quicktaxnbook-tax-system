import express from 'express';
import rateLimit from 'express-rate-limit';

import { authenticate, requirePlatformOwner } from '@/shared/middlewares/auth';
import { authLimiter } from '@/shared/middlewares/rate-limiter';

import * as ghlController from './ghl.controller';

const router = express.Router();

// ---------------------------------------------------------------------------
// Firm-side GoHighLevel connect - the /firms/:locationId page
// ---------------------------------------------------------------------------
// Opened from a GoHighLevel custom menu link, so it is deliberately public and
// rate-limited: the sub-account's Private Integration Token is the credential,
// and it is verified live against GoHighLevel before anything is stored.
//
// The location id in the URL is never trusted on its own - it is checked
// against the connected agency first (`getFirmLocationState`).
router.get('/firm/:locationId', authLimiter, ghlController.getFirmLocationState);
router.post('/firm/connect', authLimiter, ghlController.connectFirmGhl);

// Link entry: the sub-account id (and team member id) in the URL are checked live
// against GoHighLevel, then a session is issued. Failed attempts are rate-limited.
const entryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  skipSuccessfulRequests: true,
});
router.post('/firm/enter', entryLimiter, ghlController.enterFirm);
router.post('/firm/team-enter', entryLimiter, ghlController.enterTeam);

// Linking a sub-account to a firm is an agency action, so it needs a proven
// agency session. Kept here rather than under /platform so the firm flow has no
// dependency on the platform area.
router.post('/firm/link', authenticate(), requirePlatformOwner, ghlController.linkFirmLocation);

export default router;
