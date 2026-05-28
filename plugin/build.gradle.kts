plugins {
    kotlin("jvm") version "2.2.0"
    id("com.gradleup.shadow") version "9.0.0"
}

group = "app.rune"
version = "0.3.5"

repositories {
    mavenCentral()
    // Paper API + Adventure + brigadier + bungeecord-chat all resolve here.
    // paperweight-userdev is intentionally not used: the plugin only touches
    // the public Bukkit/Paper API so remap/reobf is unnecessary.
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")

    // CBOR walker for HostCommand decoding / HostEvent encoding.
    implementation("co.nstant.in:cbor:0.9")

    // Classpath scanning -- discovers every Bukkit/Paper Event subclass at
    // startup so we can auto-register a forwarder for each one.
    implementation("io.github.classgraph:classgraph:4.8.179")

    // Runtime bytecode generation -- powers `rune.implement(class, methods)`
    // which subclasses arbitrary Java abstract classes / implements
    // interfaces from JS. Used e.g. to register PAPI PlaceholderExpansions
    // without hardcoding PAPI knowledge in the plugin.
    implementation("net.bytebuddy:byte-buddy:1.15.10")

    implementation(kotlin("stdlib"))
}

// Toolchain is JDK 25, but Kotlin 2.2.0's highest supported bytecode target
// is JVM 24, so we cap both compilers there. The class files still run fine
// on JDK 25 (forward-compatible), and FFM API references are resolved at
// runtime so the bytecode level doesn't gate them.
java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
    sourceCompatibility = JavaVersion.VERSION_24
    targetCompatibility = JavaVersion.VERSION_24
}

kotlin {
    jvmToolchain(25)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_24)
    }
}

// ---------------------------------------------------------------------------
// Native binary discovery
//
// The shadowJar bundles two binaries per platform:
//   * rune_loader.{dll,so,dylib} -- built by `cargo build --release -p rune-loader`
//   * libnode.{dll,so,dylib}     -- pre-built; located via $RUNE_NODE_ROOT or
//                                   tools/libnode-cache/v<ver>/<platform>/out/Release/
//
// All paths are resolved from environment + gradle defaults. NO local-machine
// paths are hardcoded -- contributors set $RUNE_NODE_ROOT (or use
// `node tools/fetch-libnode.mjs` to populate the cache).
// ---------------------------------------------------------------------------

/**
 * Detect host OS+arch and return:
 *   - resourceDir:  in-jar resource path segment, e.g. `windows-x86_64`. MUST
 *                   match NativeLibraryExtractor's lookup at runtime.
 *   - cacheDir:     on-disk libnode-cache segment, e.g. `windows-x64`. MUST
 *                   match what tools/fetch-libnode.mjs writes (and what
 *                   crates/rune-runtime-node/build.rs reads).
 *   - loaderName / libnodeName: platform-specific shared library filenames.
 */
data class HostPlatform(
    val resourceDir: String,
    val cacheDir: String,
    val loaderName: String,
    val libnodeName: String,
)

fun hostPlatform(): HostPlatform {
    val rawOs = System.getProperty("os.name").lowercase()
    val rawArch = System.getProperty("os.arch").lowercase()
    val os = when {
        rawOs.contains("win")              -> "windows"
        rawOs.contains("mac") ||
        rawOs.contains("darwin")           -> "macos"
        rawOs.contains("linux")            -> "linux"
        else -> throw GradleException("unsupported OS: $rawOs")
    }
    // Two naming conventions, one host:
    //   resourceArch -- Java os.arch flavor used by NativeLibraryExtractor
    //   cacheArch    -- the GitHub-Actions matrix flavor used by fetch-libnode
    val (resourceArch, cacheArch) = when (rawArch) {
        "amd64", "x86_64"  -> "x86_64"   to "x64"
        "aarch64", "arm64" -> "aarch64"  to "arm64"
        else -> throw GradleException("unsupported arch: $rawArch")
    }
    val (loaderName, libnodeName) = when (os) {
        "windows" -> "rune_loader.dll"      to "libnode.dll"
        "macos"   -> "librune_loader.dylib" to "libnode.dylib"
        "linux"   -> "librune_loader.so"    to "libnode.so"
        else -> error("unreachable")
    }
    return HostPlatform(
        resourceDir = "$os-$resourceArch",
        cacheDir    = "$os-$cacheArch",
        loaderName  = loaderName,
        libnodeName = libnodeName,
    )
}

/** Resolve the libnode root via env + cache search. */
fun resolveLibnodeRoot(): java.io.File? {
    System.getenv("RUNE_NODE_ROOT")?.let { return file(it) }

    val version = System.getenv("RUNE_NODE_VERSION") ?: "22.20.0"
    val host = hostPlatform()
    // tools/libnode-cache lives at the repo root (parent of `plugin/`).
    val cache = rootProject.projectDir.parentFile
        .resolve("tools/libnode-cache/v$version/${host.cacheDir}")
    return if (cache.resolve("src/node.h").exists()) cache else null
}

tasks {
    shadowJar {
        archiveClassifier.set("")
        archiveFileName.set("rune-${project.version}.jar")

        val host = hostPlatform()
        val resourcePath = "native/${host.resourceDir}"

        // 1. The cdylib that Panama loads. Built by the rune-loader crate;
        // path is auto-derived from the workspace's target/release/.
        val loaderJar = rootProject.projectDir.parentFile
            .resolve("target/release/${host.loaderName}")
        from(loaderJar) { into(resourcePath) }

        // 2. libnode -- the JS engine the loader links against. Discovered
        // via $RUNE_NODE_ROOT or tools/libnode-cache/. Failing to find it
        // is a hard error: the loader has libnode as a non-optional import
        // on every platform, so a jar without libnode is unusable. We'd
        // rather fail the build now than ship a broken jar.
        val libnodeRoot = resolveLibnodeRoot()
            ?: throw GradleException(
                "shadowJar: no libnode found. Set RUNE_NODE_ROOT to a built " +
                    "Node tree, or run `node tools/fetch-libnode.mjs` from the repo root."
            )
        val libnode = libnodeRoot.resolve("out/Release/${host.libnodeName}")
        if (!libnode.exists()) {
            throw GradleException(
                "shadowJar: libnode root resolved to $libnodeRoot but " +
                    "${host.libnodeName} is missing under out/Release/."
            )
        }
        from(libnode) { into(resourcePath) }
        logger.lifecycle("shadowJar: bundling ${host.libnodeName} from $libnode")
    }

    build {
        dependsOn(shadowJar)
    }
}
