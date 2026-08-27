import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

let client: SESv2Client | undefined;

export function passwordResetEmailConfigured(): boolean {
  return Boolean(process.env.AWS_REGION?.trim() && process.env.PASSWORD_RESET_FROM_EMAIL?.trim());
}

export async function sendPasswordResetCode(to: string, code: string): Promise<void> {
  const region = process.env.AWS_REGION?.trim();
  const from = process.env.PASSWORD_RESET_FROM_EMAIL?.trim();
  if (!region || !from) throw new Error("Password reset email delivery is not configured");

  client ??= new SESv2Client({ region });
  await client.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: "Your Wanderly verification code", Charset: "UTF-8" },
        Body: {
          Text: {
            Data: `Your Wanderly password reset verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
            Charset: "UTF-8",
          },
        },
      },
    },
  }));
}
