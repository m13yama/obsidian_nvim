export type StatusLineStyle = "powerline" | "compact";

export interface NeovimSettings {
  executable: string;
  useConfig: boolean;
  initPath: string;
  enabled: boolean;
  statusLineStyle: StatusLineStyle;
  navigation: boolean;
}

export const DEFAULT_SETTINGS: NeovimSettings = {
  executable: "nvim",
  useConfig: true,
  initPath: "",
  enabled: true,
  statusLineStyle: "powerline",
  navigation: true,
};
