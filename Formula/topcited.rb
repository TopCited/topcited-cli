# Template: scripts/render-formula.ts fills in {{VERSION}} and the
# {{SHA256_*}} values from a release's SHA256SUMS, and release.yml pushes the
# result to TopCited/homebrew-tap as Formula/topcited.rb.
class Topcited < Formula
  desc "TopCited CLI: AI visibility (GEO) from your terminal and your agents"
  homepage "https://topcited.ai"
  version "{{VERSION}}"

  on_macos do
    on_arm do
      url "https://github.com/TopCited/topcited-cli/releases/download/v{{VERSION}}/topcited-darwin-arm64"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
    on_intel do
      url "https://github.com/TopCited/topcited-cli/releases/download/v{{VERSION}}/topcited-darwin-x64"
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/TopCited/topcited-cli/releases/download/v{{VERSION}}/topcited-linux-arm64"
      sha256 "{{SHA256_LINUX_ARM64}}"
    end
    on_intel do
      url "https://github.com/TopCited/topcited-cli/releases/download/v{{VERSION}}/topcited-linux-x64"
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  def install
    # The download is the bare binary, staged under its release asset name.
    bin.install Dir["topcited-*"].first => "topcited"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/topcited --version")
  end
end
