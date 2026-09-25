"use server";

// Befehl 20.5: eigener E-Mail-Versand. Jede Aktion nur für den Inhaber (requireRole("OWNER")) – im Supportmodus
// lehnt requireRole ohnehin jede Aktion ab. Der Mandant kommt ausschließlich aus der Sitzung, nie aus dem Formular.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { DomainError } from "@/lib/integrity";
import { disableTenantSmtp, enableTenantSmtp, saveMailSettings, sendSmtpTestMail, testMailConnection } from "@/lib/tenant-mail";

export type MailFormState = { error?: string; ok?: string } | undefined;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

function asState(e: unknown): MailFormState {
  if (e instanceof DomainError) return { error: e.message };
  throw e;
}

export async function saveMailSettingsAction(_prev: MailFormState, fd: FormData): Promise<MailFormState> {
  const { tenant, user } = await requireRole("OWNER");
  try {
    const view = await saveMailSettings(tenant.id, { id: user.id, name: user.name }, {
      host: str(fd, "host"),
      port: Number(str(fd, "port")),
      security: str(fd, "security"),
      username: str(fd, "username"),
      newPassword: str(fd, "newPassword"),
      fromName: str(fd, "fromName"),
      fromEmail: str(fd, "fromEmail"),
      replyTo: str(fd, "replyTo"),
    });
    revalidatePath("/einstellungen/e-mail");
    return { ok: view.status === "VERIFIED" ? "Gespeichert." : "Gespeichert. Bitte jetzt „Verbindung testen“." };
  } catch (e) {
    return asState(e);
  }
}

export async function testConnectionAction(_prev: MailFormState, _fd: FormData): Promise<MailFormState> {
  void _fd;
  const { tenant, user } = await requireRole("OWNER");
  try {
    const res = await testMailConnection(tenant.id, { id: user.id, name: user.name });
    revalidatePath("/einstellungen/e-mail");
    return res.ok ? { ok: res.message } : { error: res.message };
  } catch (e) {
    return asState(e);
  }
}

export async function sendTestMailAction(_prev: MailFormState, fd: FormData): Promise<MailFormState> {
  const { tenant, user } = await requireRole("OWNER");
  try {
    // Ziel ist immer das eigene Konto des angemeldeten Inhabers – kein frei wählbarer Empfänger (kein offenes Relay)
    const res = await sendSmtpTestMail(tenant.id, { id: user.id, name: user.name, email: user.email }, str(fd, "nonce"));
    revalidatePath("/einstellungen/e-mail");
    return res.ok ? { ok: res.message } : { error: res.message };
  } catch (e) {
    return asState(e);
  }
}

export async function enableTenantSmtpAction(_prev: MailFormState, _fd: FormData): Promise<MailFormState> {
  void _fd;
  const { tenant, user } = await requireRole("OWNER");
  try {
    await enableTenantSmtp(tenant.id, { id: user.id, name: user.name });
    revalidatePath("/einstellungen/e-mail");
    revalidatePath("/einstellungen");
    return { ok: "Eigener E-Mail-Versand ist aktiv. Geschäftliche E-Mails gehen ab jetzt über Ihren SMTP-Server." };
  } catch (e) {
    return asState(e);
  }
}

export async function disableTenantSmtpAction(_prev: MailFormState, _fd: FormData): Promise<MailFormState> {
  void _fd;
  const { tenant, user } = await requireRole("OWNER");
  try {
    await disableTenantSmtp(tenant.id, { id: user.id, name: user.name });
    revalidatePath("/einstellungen/e-mail");
    revalidatePath("/einstellungen");
    return { ok: "Eigener E-Mail-Versand deaktiviert. Geschäftliche E-Mails laufen wieder über den RentBase-Versanddienst." };
  } catch (e) {
    return asState(e);
  }
}
