export interface NeovimSettings {
  executable: string;
  useConfig: boolean;
  initPath: string;
  enabled: boolean;
}

export const DEFAULT_SETTINGS: NeovimSettings = {
  executable: "nvim",
  useConfig: false,
  initPath: "",
  enabled: true,
};
