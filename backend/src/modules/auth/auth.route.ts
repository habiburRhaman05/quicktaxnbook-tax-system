import express from 'express';

import * as authController from './auth.controller';

const router = express.Router();

// Shared staff login - Platform Owner / Firm Admin / Firm Team
router.post('/login', authController.login);
router.post('/refresh-token', authController.refreshTokens);
router.post('/logout', authController.logout);

// Client login - 3 steps: email -> password -> emailed OTP
router.post('/client/login/start', authController.clientLoginStart);
router.post('/client/login/password', authController.clientLoginPassword);
router.post('/client/login/verify-otp', authController.clientLoginVerifyOtp);

// Self-service password reset - Platform Owner & Firm Admin only
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

export default router;
