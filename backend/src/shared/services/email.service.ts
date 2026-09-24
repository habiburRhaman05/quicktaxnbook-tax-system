import nodemailer from 'nodemailer';

import config from '@/config/config';
import logger from '@/config/logger';
import {
  firmAdminWelcomeEmailTemplate,
  onboardingLinkEmailTemplate,
  otpEmailTemplate,
  passwordResetOtpEmailTemplate,
} from './email-templates';

export const transport = nodemailer.createTransport({
  ...config.email.smtp,
  // Without these, a blocked/slow SMTP host (common on hosts that firewall
  // outbound 587, or bad Gmail app-password creds) can hang the connection
  // for minutes. Since sendEmail() is awaited right after a DB write in the
  // callers below, that hang used to stall the whole request - the record
  // was already committed, but the client never got a response and the UI
  // spun forever. Fail fast instead.
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,
});
/* istanbul ignore next */
if (config.env !== 'test') {
  transport
    .verify()
    .then(() => logger.info('💌 Connected to email server'))
    .catch(() =>
      logger.warn(
        'Unable to connect to email server. Make sure you have configured the SMTP options in .env'
      )
    );
}

export const sendEmail = async (
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<void> => {
  const msg = { from: config.email.from, to, subject, text, html };
  await transport.sendMail(msg);
};

export const sendOtpEmail = async (to: string, code: string, expiresInMinutes: number) => {
  const subject = `${code} is your ${config.appName} login code`;
  const text = `Your login code is: ${code}\n\nThis code expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  await sendEmail(to, subject, text, otpEmailTemplate(code, expiresInMinutes));
};

export const sendFirmAdminWelcomeEmail = async (to: string, firmName: string, loginUrl: string) => {
  const subject = `Your ${config.appName} firm account is ready`;
  const text = `Welcome to ${config.appName}!

A firm account for "${firmName}" has been created and you've been set up as the Firm Admin.

Login here: ${loginUrl}

Your platform administrator will share your login credentials with you separately.`;
  await sendEmail(to, subject, text, firmAdminWelcomeEmailTemplate(firmName, loginUrl));
};

export const sendOnboardingLinkEmail = async (
  to: string,
  firmName: string,
  onboardingUrl: string
) => {
  const subject = `Complete your onboarding with ${firmName}`;
  const text = `Hello,

${firmName} has invited you to set up your client portal account.

Complete your onboarding here: ${onboardingUrl}

This link will expire, so please complete it soon. If you weren't expecting this, you can ignore this email.`;
  await sendEmail(to, subject, text, onboardingLinkEmailTemplate(firmName, onboardingUrl));
};

export const sendPasswordResetOtpEmail = async (
  to: string,
  code: string,
  expiresInMinutes: number
) => {
  const subject = `${code} is your ${config.appName} password reset code`;
  const text = `A password reset was requested for your account.

Your reset code is: ${code}

This code expires in ${expiresInMinutes} minutes. If you did not request this, you can safely ignore this email. Your password will not change.`;
  await sendEmail(to, subject, text, passwordResetOtpEmailTemplate(code, expiresInMinutes));
};
