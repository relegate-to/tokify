const { withAppBuildGradle } = require('expo/config-plugins');

// The generated build.gradle signs release builds with the debug keystore.
// Sign them with the upload key instead whenever Gradle is given one (CI sets
// ORG_GRADLE_PROJECT_tokifyUpload*; locally ~/.gradle/gradle.properties works),
// and keep debug signing otherwise so local release builds still run.
const releaseSigningConfig = `signingConfigs {
        release {
            if (findProperty('tokifyUploadStoreFile')) {
                storeFile file(findProperty('tokifyUploadStoreFile'))
                storePassword findProperty('tokifyUploadStorePassword')
                keyAlias findProperty('tokifyUploadKeyAlias')
                keyPassword findProperty('tokifyUploadKeyPassword')
            }
        }`;

const releaseBuildType =
    /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/;

module.exports = function withReleaseSigning(config) {
    return withAppBuildGradle(config, (config) => {
        const gradle = config.modResults.contents;
        if (gradle.includes('tokifyUploadStoreFile')) {
            return config;
        }
        if (!gradle.includes('signingConfigs {') || !releaseBuildType.test(gradle)) {
            throw new Error('withReleaseSigning: build.gradle no longer matches the expected template');
        }
        config.modResults.contents = gradle
            .replace(
                releaseBuildType,
                "$1signingConfig(findProperty('tokifyUploadStoreFile') ? signingConfigs.release : signingConfigs.debug)",
            )
            .replace('signingConfigs {', releaseSigningConfig);
        return config;
    });
};
