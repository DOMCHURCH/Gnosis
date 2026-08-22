// Browser-side mirror of the server's filetree shapes (src/filetree.ts). Kept as a
// tiny standalone module so FileBrowser doesn't import Node-only server code.

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface TreeResult {
  cwd: string;
  tree: TreeNode[];
  truncated: boolean;
}

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
}
