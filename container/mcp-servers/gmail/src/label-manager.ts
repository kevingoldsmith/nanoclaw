import { gmail_v1 } from "googleapis";

interface LabelOptions {
  messageListVisibility?: "show" | "hide";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
}

interface LabelListResult {
  all: gmail_v1.Schema$Label[];
  system: gmail_v1.Schema$Label[];
  user: gmail_v1.Schema$Label[];
  count: { total: number; system: number; user: number };
}

export async function createLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  options: LabelOptions = {},
): Promise<gmail_v1.Schema$Label> {
  try {
    const response = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        messageListVisibility: options.messageListVisibility || "show",
        labelListVisibility: options.labelListVisibility || "labelShow",
      },
    });
    return response.data;
  } catch (error: any) {
    if (error.message?.includes("already exists")) {
      throw new Error(`Label "${labelName}" already exists. Please use a different name.`);
    }
    throw new Error(`Failed to create label: ${error.message}`);
  }
}

export async function updateLabel(
  gmail: gmail_v1.Gmail,
  labelId: string,
  updates: gmail_v1.Schema$Label,
): Promise<gmail_v1.Schema$Label> {
  try {
    await gmail.users.labels.get({ userId: "me", id: labelId });
    const response = await gmail.users.labels.update({
      userId: "me",
      id: labelId,
      requestBody: updates,
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`);
    }
    throw new Error(`Failed to update label: ${error.message}`);
  }
}

export async function deleteLabel(
  gmail: gmail_v1.Gmail,
  labelId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const label = await gmail.users.labels.get({ userId: "me", id: labelId });
    if (label.data.type === "system") {
      throw new Error(`Cannot delete system label with ID "${labelId}".`);
    }
    await gmail.users.labels.delete({ userId: "me", id: labelId });
    return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`);
    }
    throw new Error(`Failed to delete label: ${error.message}`);
  }
}

export async function listLabels(gmail: gmail_v1.Gmail): Promise<LabelListResult> {
  try {
    const response = await gmail.users.labels.list({ userId: "me" });
    const labels = response.data.labels || [];
    const systemLabels = labels.filter((l) => l.type === "system");
    const userLabels = labels.filter((l) => l.type === "user");
    return {
      all: labels,
      system: systemLabels,
      user: userLabels,
      count: {
        total: labels.length,
        system: systemLabels.length,
        user: userLabels.length,
      },
    };
  } catch (error: any) {
    throw new Error(`Failed to list labels: ${error.message}`);
  }
}

export async function findLabelByName(
  gmail: gmail_v1.Gmail,
  labelName: string,
): Promise<gmail_v1.Schema$Label | null> {
  try {
    const result = await listLabels(gmail);
    return (
      result.all.find(
        (l) => l.name?.toLowerCase() === labelName.toLowerCase(),
      ) || null
    );
  } catch (error: any) {
    throw new Error(`Failed to find label: ${error.message}`);
  }
}

export async function getOrCreateLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  options: LabelOptions = {},
): Promise<gmail_v1.Schema$Label> {
  try {
    const existing = await findLabelByName(gmail, labelName);
    if (existing) return existing;
    return await createLabel(gmail, labelName, options);
  } catch (error: any) {
    throw new Error(`Failed to get or create label: ${error.message}`);
  }
}
