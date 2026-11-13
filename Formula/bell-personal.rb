class BellPersonal < Formula
  desc "Local-first daily workspace for tasks, inbox, calendar, ideas, and habits"
  homepage "https://github.com/Suzu1Dev/BELL-Personal"
  url "https://github.com/Suzu1Dev/BELL-Personal/archive/refs/heads/main.tar.gz"
  version "1.0.1"
  license "Apache-2.0"
  head "https://github.com/Suzu1Dev/BELL-Personal.git", branch: "main"

  depends_on "node"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bell-personal --version")
    assert_match "doctor", shell_output("#{bin}/bell-personal --help")
  end
end
