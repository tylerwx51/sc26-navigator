{
  description = "SC26 Navigator - Android build + emulator test environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      android = pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ "35" ];
        buildToolsVersions = [ "35.0.0" ];
        includeEmulator = true;
        includeSystemImages = true;
        systemImageTypes = [ "google_apis" ];
        abiVersions = [ "x86_64" ];
        includeNDK = false;
      };
      sdk = android.androidsdk;
    in
    {
      packages.${system}.androidsdk = sdk;

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          sdk
          pkgs.jdk17
          pkgs.gradle_8
          (pkgs.python3.withPackages (p: [ p.beautifulsoup4 p.lxml p.numpy p.scipy p.svgpathtools ]))
          pkgs.librsvg
          pkgs.nodejs_22
        ];
        ANDROID_HOME = "${sdk}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "${sdk}/libexec/android-sdk";
        JAVA_HOME = "${pkgs.jdk17.home}";
        GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/libexec/android-sdk/build-tools/35.0.0/aapt2";
        shellHook = ''
          export ANDROID_AVD_HOME="$PWD/.avd"
          export ANDROID_USER_HOME="$PWD/.android-user"
          mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"
        '';
      };
    };
}
