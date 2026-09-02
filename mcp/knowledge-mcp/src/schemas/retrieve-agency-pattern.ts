/**
 * Input schema for the `retrieve_agency_pattern` tool.
 */
import { z } from "zod";

export const retrieveAgencyPatternInputShape = {
  agency: z
    .string()
    .min(2)
    .max(100)
    .describe(
      "Agency name or fragment, case-insensitive, minimum 2 characters. " +
        "For example Veterans, Department of Energy, GSA."
    ),
};

export const RetrieveAgencyPatternInput = z.object(retrieveAgencyPatternInputShape);
export type RetrieveAgencyPatternInputT = z.infer<typeof RetrieveAgencyPatternInput>;
