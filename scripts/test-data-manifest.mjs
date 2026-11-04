export const testDataManifest = {
    downloads: [
        {
            name: 'Mooneye test suite',
            path: 'roms/mooneye.zip',
            sha256: '18aa29462dfe1fcd32a2cb3621733abdc72410074918b9245aa99a6920f7d3f2',
            url: 'https://gekkio.fi/files/mooneye-test-suite/mts-20260714-0944-31510e1/mts-20260714-0944-31510e1.zip',
        },
        {
            name: 'dmg-acid2 v1.0',
            path: 'roms/dmg-acid2.gb',
            sha256: '464e14b7d42e7feea0b7ede42be7071dc88913f75b9ffa444299424b63d1dff1',
            url: 'https://github.com/mattcurrie/dmg-acid2/releases/download/v1.0/dmg-acid2.gb',
        },
        {
            name: 'cgb-acid2 v1.1',
            path: 'roms/cgb-acid2.gbc',
            sha256: '197fb0bcec544f0400527fc707e0a94f55435974986e6986b424ace5de81720e',
            url: 'https://github.com/mattcurrie/cgb-acid2/releases/download/v1.1/cgb-acid2.gbc',
        },
    ],
    sources: [
        {
            name: 'dmg-acid2',
            path: 'sources/dmg-acid2',
            repository: 'https://github.com/mattcurrie/dmg-acid2.git',
            revision: 'dc2295408f881637ff69f784d8d93f3d2db30181',
        },
        {
            name: 'cgb-acid2',
            path: 'sources/cgb-acid2',
            repository: 'https://github.com/mattcurrie/cgb-acid2.git',
            revision: 'fa5b7f86d6fb599f79e55169494d981a7af75a31',
        },
        {
            name: 'SameSuite',
            path: 'sources/samesuite',
            repository: 'https://github.com/LIJI32/SameSuite.git',
            revision: 'f15645fb049a47ea235f6d2c9a033e72d8087901',
        },
        {
            name: 'mGBA suite',
            path: 'sources/mgba-suite',
            repository: 'https://github.com/mgba-emu/suite.git',
            revision: 'e6942030d25ffe3ba76c72b73a86da073ec857cc',
        },
        {
            name: 'SameBoy',
            path: 'sources/sameboy',
            repository: 'https://github.com/LIJI32/SameBoy.git',
            revision: '213a12ce93d66b105a113debd9396306066a7cfc',
        },
    ],
    inventories: {
        mooneye: {
            count: 115,
            extension: '.gb',
            path: 'roms/mooneye/mts-20260714-0944-31510e1',
            sha256: 'e7c613e81445a500795cb92681f8afb316f8a3202ef5af8964664d49cf411b58',
        },
        samesuite: {
            count: 78,
            extension: '.gb',
            path: 'roms/samesuite',
            sha256: '00fe1a58230f7dc5423f0bc8edca47a6a62e69450fb42453cc3cd0a00037b7c2',
        },
    },
    mgbaSuite: {
        path: 'roms/mgba-suite.gba',
        sha256: '8cf68cd31c5468a70aca8a1c5b63dc372fe755c40b446cf6aa6d0fc6e3a1f035',
        size: 524288,
    },
    freeBootROMs: [
        ['agb_boot.bin', '648fd2ade35a77ce93fb4ceac754b0f0465f1eaf0db0cbef1bed55bfd8a71794'],
        ['cgb0_boot.bin', '2c297b6cb762cd0a50253449fd026ae30c76f0cc30b919e2ff498bca7682eacc'],
        ['cgb_boot.bin', 'f767b8e7e510a255f81328c89dba6e0c996b370e1bc86aebb8584a7da47a5bba'],
        ['dmg_boot.bin', '6f64da4cecd7e54e2f928eb3e3ba7810a7a567d0d247cc71737d1771e073a916'],
        ['mgb_boot.bin', '12eb4b96f8c2c19cd51c209af1f0a5aa19e01f886114ae848258a592f408ef4e'],
        ['sgb2_boot.bin', '8a65465a9da7ec657726a671da9a85963cf19d2c975e499aea6b97eb37e0b6ea'],
        ['sgb_boot.bin', 'b60d493a7944ccf74c81f1e7b6bf38c2c7029e296648ea0e74cb22b10dd1fcb8'],
    ],
    originalBIOS: {
        dmg0: {
            file: 'dmg0_boot.bin',
            md5: 'a8f84a0ac44da5d3f0ee19f9cea80a8c',
            size: 256,
        },
        dmg: {
            file: 'dmg_boot.bin',
            md5: '32fbbd84168d3482956eb3c5051637f5',
            size: 256,
        },
        mgb: {
            file: 'mgb_boot.bin',
            md5: '71a378e71ff30b2d8a1f02bf5c7896aa',
            size: 256,
        },
        cgb0: {
            file: 'cgb0_boot.bin',
            md5: '7c773f3c0b01cb73bca8e83227287b7f',
            size: 2304,
        },
        cgb: {
            file: 'cgb_boot.bin',
            md5: 'dbfce9db9deaa2567f6a84fde55f9680',
            size: 2304,
        },
        gba: {
            file: 'gba_bios.bin',
            md5: 'a860e8c0b6d573d191e4ec7db1b1e4f6',
            size: 16384,
        },
    },
    devkitARMImage: 'devkitpro/devkitarm:20260610@sha256:116afba8df8453961de2936ffab20dd441edf4d682856c1ec8b0e53d7ed0bbf5',
};
