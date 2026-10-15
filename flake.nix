{
  description = "A flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-26.05";
    nixpkgs-unstable.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-unstable,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        unstable = import nixpkgs-unstable {
          inherit system;
          config.allowUnfree = true;
        };
        shellPkgs = pkgs.lib.flatten [
          (with pkgs; [
            bun
            nodejs
          ])
          (with unstable; [
          ])
        ];
        ldPkgs = with pkgs; [
          stdenv.cc.cc
          zlib
          glib
          libxcb
          libglvnd
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath ldPkgs;
          packages = pkgs.lib.flatten [
            shellPkgs
          ];
          shellHook = "";
          buildInputs = [ pkgs.bashInteractive ];
        };
      }
    );
}
