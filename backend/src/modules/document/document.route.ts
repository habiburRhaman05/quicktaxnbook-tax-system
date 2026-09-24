import express from 'express';

import { authenticate, requireFirmStaff } from '@/shared/middlewares/auth';
import { documentUpload } from '@/shared/middlewares/upload';

import * as controller from './document.controller';

const router = express.Router();

router.use(authenticate());

// --- Firm staff -------------------------------------------------------------
router.post('/requests', requireFirmStaff, controller.createRequest);
router.get('/requests/client/:clientId', requireFirmStaff, controller.listClientRequests);
router.patch('/requests/:requestId/review', requireFirmStaff, controller.reviewRequest);
router.get('/client/:clientId', requireFirmStaff, controller.listClientDocuments);

// --- Client portal ----------------------------------------------------------
// Open to both roles: a client reads their own (scoped in the controller from
// their access grants), and staff can read on a client's behalf.
router.get('/my/requests', controller.listMyRequests);
router.get('/my/documents', controller.listMyDocuments);

// --- Upload - clients fulfilling a request, or uploading unprompted ---------
router.post('/upload', documentUpload.single('file'), controller.uploadDocument);

export default router;
