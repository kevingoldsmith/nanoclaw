import { gmail_v1 } from "googleapis";

export async function createFilter(
  gmail: gmail_v1.Gmail,
  criteria: gmail_v1.Schema$FilterCriteria,
  action: gmail_v1.Schema$FilterAction,
): Promise<gmail_v1.Schema$Filter> {
  try {
    const response = await gmail.users.settings.filters.create({
      userId: "me",
      requestBody: { criteria, action },
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 400) {
      throw new Error(`Invalid filter criteria or action: ${error.message}`);
    }
    throw new Error(`Failed to create filter: ${error.message}`);
  }
}

export async function listFilters(
  gmail: gmail_v1.Gmail,
): Promise<{ filters: gmail_v1.Schema$Filter[]; count: number }> {
  try {
    const response = await gmail.users.settings.filters.list({ userId: "me" });
    const filters = response.data.filter || [];
    return { filters, count: filters.length };
  } catch (error: any) {
    throw new Error(`Failed to list filters: ${error.message}`);
  }
}

export async function getFilter(
  gmail: gmail_v1.Gmail,
  filterId: string,
): Promise<gmail_v1.Schema$Filter> {
  try {
    const response = await gmail.users.settings.filters.get({
      userId: "me",
      id: filterId,
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Filter with ID "${filterId}" not found.`);
    }
    throw new Error(`Failed to get filter: ${error.message}`);
  }
}

export async function deleteFilter(
  gmail: gmail_v1.Gmail,
  filterId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    await gmail.users.settings.filters.delete({ userId: "me", id: filterId });
    return { success: true, message: `Filter "${filterId}" deleted successfully.` };
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Filter with ID "${filterId}" not found.`);
    }
    throw new Error(`Failed to delete filter: ${error.message}`);
  }
}

export const filterTemplates = {
  fromSender: (senderEmail: string, labelIds: string[] = [], archive = false) => ({
    criteria: { from: senderEmail },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: archive ? ["INBOX"] : undefined,
    },
  }),

  withSubject: (subjectText: string, labelIds: string[] = [], markAsRead = false) => ({
    criteria: { subject: subjectText },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: markAsRead ? ["UNREAD"] : undefined,
    },
  }),

  withAttachments: (labelIds: string[] = []) => ({
    criteria: { hasAttachment: true },
    action: { addLabelIds: labelIds },
  }),

  largeEmails: (sizeInBytes: number, labelIds: string[] = []) => ({
    criteria: { size: sizeInBytes, sizeComparison: "larger" as const },
    action: { addLabelIds: labelIds },
  }),

  containingText: (searchText: string, labelIds: string[] = [], markImportant = false) => ({
    criteria: { query: `"${searchText}"` },
    action: {
      addLabelIds: markImportant ? [...labelIds, "IMPORTANT"] : labelIds,
    },
  }),

  mailingList: (listIdentifier: string, labelIds: string[] = [], archive = true) => ({
    criteria: { query: `list:${listIdentifier} OR subject:[${listIdentifier}]` },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: archive ? ["INBOX"] : undefined,
    },
  }),
};
