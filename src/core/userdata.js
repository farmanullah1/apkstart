'use strict';
/**
 * Generates a minimal but valid ext4 empty image for Android Emulator as a userdata seed.
 *
 * Requirements:
 * 1. System image bundles (system-images/.../userdata.img) contain a 1MB all-zero placeholder.
 *    Without proper formatting, kernel reports "Invalid ext4 superblock on /dev/block/vdc" and recovery reboot loop.
 * 2. Block size must be 4096 (due to Android 13 metadata encryption and dm-default-key).
 * 3. Must include EXT4_FEATURE_INCOMPAT_ENCRYPT (0x10000) for vold `cryptfs init_user0`.
 *
 * Image is only 64MB; emulator resizes it to dataPartition size configured in AVD.
 */

const BLOCK = 4096;
const INODE_SIZE = 128;
const FIRST_INO = 11;

// ext4 feature flags: without COMPAT_EXT_ATTR setxattr returns EOPNOTSUPP, breaking SELinux labels
const COMPAT_EXT_ATTR = 0x8;
const COMPAT_DIR_INDEX = 0x20;
const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_ENCRYPT = 0x10000;
const RO_COMPAT_SPARSE_SUPER = 0x1;
const RO_COMPAT_LARGE_FILE = 0x2;

/**
 * @param {{sizeMB?: number, encrypt?: boolean}} [opts]
 *   encrypt=false excludes ENCRYPT flag (used before running legacy e2fsck/resize2fs which lacks encrypt support)
 * @returns {Buffer} Raw bytes writable as userdata image
 */
function buildEmptyExt4(opts = {}) {
  const sizeMB = Math.max(8, Math.min(96, Math.round(opts.sizeMB || 64)));
  const blocks = Math.floor((sizeMB * 1024 * 1024) / BLOCK);
  // Single block group: at 4KB block, up to 8*4096 = 32768 blocks (128MB) per group
  const blocksPerGroup = Math.min(blocks, 8 * BLOCK);

  let inodes = Math.max(256, Math.round(blocks / 4));
  inodes = Math.ceil(inodes / 8) * 8;
  const inodeTableBlocks = Math.ceil((inodes * INODE_SIZE) / BLOCK);

  const GD_BLOCK = 1;
  const BB_BLOCK = 2;
  const IB_BLOCK = 3;
  const ITABLE_BLOCK = 4;
  const DIR_BLOCK = ITABLE_BLOCK + inodeTableBlocks;
  const usedBlocks = DIR_BLOCK + 1; // Occupied blocks (0..DIR_BLOCK)

  const buf = Buffer.alloc(blocks * BLOCK, 0);
  const now = Math.floor(Date.now() / 1000);
  const sb = 1024; // Superblock is fixed at offset 1024

  // ---------- superblock ----------
  const reserved = Math.floor(blocks * 0.05);
  buf.writeUInt32LE(inodes, sb + 0x00);                       // s_inodes_count
  buf.writeUInt32LE(blocks, sb + 0x04);                       // s_blocks_count_lo
  buf.writeUInt32LE(reserved, sb + 0x08);                     // s_r_blocks_count
  buf.writeUInt32LE(blocks - usedBlocks, sb + 0x0C);          // s_free_blocks_count
  buf.writeUInt32LE(inodes - (FIRST_INO - 1), sb + 0x10);     // s_free_inodes_count (deducting 1~10 reserved)
  buf.writeUInt32LE(0, sb + 0x14);                            // s_first_data_block (0 for 4KB)
  buf.writeUInt32LE(2, sb + 0x18);                            // s_log_block_size = 2 → 4096
  buf.writeUInt32LE(2, sb + 0x1C);                            // s_log_cluster_size (must match block size, else EINVAL)
  buf.writeUInt32LE(blocksPerGroup, sb + 0x20);               // s_blocks_per_group
  buf.writeUInt32LE(blocksPerGroup, sb + 0x24);               // s_clusters_per_group
  buf.writeUInt32LE(inodes, sb + 0x28);                       // s_inodes_per_group
  buf.writeUInt32LE(now, sb + 0x2C);                          // s_mtime
  buf.writeUInt32LE(now, sb + 0x30);                          // s_wtime
  buf.writeUInt16LE(0, sb + 0x34);                            // s_mnt_count
  buf.writeUInt16LE(0xFFFF, sb + 0x36);                       // s_max_mnt_count
  buf.writeUInt16LE(0xEF53, sb + 0x38);                       // magic
  buf.writeUInt16LE(1, sb + 0x3A);                            // s_state = clean
  buf.writeUInt16LE(1, sb + 0x3C);                            // s_errors = continue (never 0)
  buf.writeUInt16LE(0, sb + 0x3E);                            // s_minor_rev_level
  buf.writeUInt32LE(now, sb + 0x40);                          // s_lastcheck
  buf.writeUInt32LE(0, sb + 0x44);                            // s_checkinterval
  buf.writeUInt32LE(0, sb + 0x48);                            // s_creator_os = Linux
  buf.writeUInt32LE(1, sb + 0x4C);                            // s_rev_level = dynamic
  buf.writeUInt16LE(0, sb + 0x50);                            // s_def_resuid
  buf.writeUInt16LE(0, sb + 0x52);                            // s_def_resgid
  buf.writeUInt32LE(FIRST_INO, sb + 0x54);                    // s_first_ino
  buf.writeUInt16LE(INODE_SIZE, sb + 0x58);                   // s_inode_size
  buf.writeUInt16LE(0, sb + 0x5A);                            // s_block_group_nr
  buf.writeUInt32LE(COMPAT_EXT_ATTR | COMPAT_DIR_INDEX, sb + 0x5C); // s_feature_compat
  buf.writeUInt32LE(INCOMPAT_FILETYPE | (opts.encrypt === false ? 0 : INCOMPAT_ENCRYPT), sb + 0x60); // s_feature_incompat
  buf.writeUInt32LE(RO_COMPAT_SPARSE_SUPER | RO_COMPAT_LARGE_FILE, sb + 0x64);
  Buffer.from('61706b7374617274303031', 'hex').copy(buf, sb + 0x68); // s_uuid
  buf.write('data', sb + 0x78, 'ascii');                      // s_volume_name
  buf.write('/data', sb + 0x88, 'ascii');                      // s_last_mounted
  buf.writeUInt32LE(0, sb + 0xC8);                             // s_algorithm_usage_bitmap
  buf.writeUInt8(0, sb + 0xCC + 1);                            // s_prealloc_blocks
  buf.writeUInt8(0, sb + 0xCE);
  // Supported encryption algorithms: 1 = AES-256-XTS, 2 = AES-256-CTS (Android default)
  buf.writeUInt32LE(1, sb + 0x274);
  buf.writeUInt32LE(2, sb + 0x278);
  buf.writeUInt8(2, sb + 0xFC);                                // s_def_hash_version = half_md4
  buf.writeUInt16LE(0, sb + 0xFE);                             // s_desc_size (0 for non-64bit)

  // ---------- group descriptor (block 1) ----------
  const gd = GD_BLOCK * BLOCK;
  buf.writeUInt32LE(BB_BLOCK, gd + 0x00);                      // bg_block_bitmap
  buf.writeUInt32LE(IB_BLOCK, gd + 0x04);                      // bg_inode_bitmap
  buf.writeUInt32LE(ITABLE_BLOCK, gd + 0x08);                  // bg_inode_table
  buf.writeUInt16LE(blocksPerGroup - usedBlocks, gd + 0x0C);   // bg_free_blocks_count
  buf.writeUInt16LE(inodes - FIRST_INO + 1, gd + 0x0E);        // bg_free_inodes_count
  buf.writeUInt16LE(1, gd + 0x10);                             // bg_used_dirs_count
  buf.writeUInt16LE(0, gd + 0x12);                             // bg_flags

  // ---------- block bitmap (block 2): bit i <-> block i ----------
  const bb = BB_BLOCK * BLOCK;
  for (let blk = 0; blk < usedBlocks; blk += 1) {
    buf[bb + (blk >> 3)] |= 1 << (blk & 7);
  }
  // Padding bits beyond actual block count must be set to 1
  for (let bit = blocks; bit < blocksPerGroup; bit += 1) {
    buf[bb + (bit >> 3)] |= 1 << (bit & 7);
  }

  // ---------- inode bitmap (block 3): 1..10 reserved for system ----------
  const ib = IB_BLOCK * BLOCK;
  for (let i = 0; i < FIRST_INO - 1; i += 1) {
    buf[ib + (i >> 3)] |= 1 << (i & 7);
  }

  // ---------- root inode (inode 2) ----------
  const rootOff = ITABLE_BLOCK * BLOCK + (2 - 1) * INODE_SIZE;
  buf.writeUInt16LE(0x41ED, rootOff + 0x00);        // S_IFDIR | 0755
  buf.writeUInt16LE(0, rootOff + 0x02);             // i_uid
  buf.writeUInt32LE(BLOCK, rootOff + 0x04);         // i_size
  buf.writeUInt32LE(now, rootOff + 0x08);           // i_atime
  buf.writeUInt32LE(now, rootOff + 0x0C);           // i_ctime
  buf.writeUInt32LE(now, rootOff + 0x10);           // i_mtime
  buf.writeUInt32LE(0, rootOff + 0x14);             // i_dtime
  buf.writeUInt16LE(0, rootOff + 0x18);             // i_gid
  buf.writeUInt16LE(2, rootOff + 0x1A);             // i_links_count
  buf.writeUInt32LE(BLOCK / 512, rootOff + 0x1C);   // i_blocks (512B units)
  buf.writeUInt32LE(0, rootOff + 0x20);             // i_flags
  buf.writeUInt32LE(DIR_BLOCK, rootOff + 0x28);     // i_block[0] (direct block without extents)

  // ---------- root directory data block ----------
  const dir = DIR_BLOCK * BLOCK;
  buf.writeUInt32LE(2, dir + 0);                    // "." -> inode 2
  buf.writeUInt16LE(12, dir + 4);
  buf.writeUInt8(1, dir + 6);                       // name_len
  buf.writeUInt8(2, dir + 7);                       // file_type = DIR
  buf.write('.', dir + 8, 'ascii');

  buf.writeUInt32LE(2, dir + 12);                   // ".." -> inode 2
  buf.writeUInt16LE(BLOCK - 12, dir + 16);
  buf.writeUInt8(2, dir + 18);
  buf.writeUInt8(2, dir + 19);
  buf.write('..', dir + 20, 'ascii');

  return buf;
}

/** Check whether an image has a valid ext4 superblock magic */
function hasExt4Superblock(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const head = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, head, 0, 2048, 0);
    if (n < 2048) return false;
    return head.readUInt16LE(1024 + 0x38) === 0xEF53;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Re-apply ENCRYPT (fscrypt) feature flag to superblock after resize2fs has expanded the filesystem.
 */
function setEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60; // s_feature_incompat
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) | INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/** Strip ENCRYPT flag before running resize2fs (older e2fsprogs reject unfamiliar flags) */
function clearEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60;
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) & ~INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the actual filesystem capacity in bytes from the superblock.
 * Verifies whether resize2fs successfully expanded the ext4 filesystem to match the image size.
 */
function fsBytes(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const sb = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, sb, 0, sb.length, 0);
    if (n < 2048) return 0;
    if (sb.readUInt16LE(1024 + 0x38) !== 0xEF53) return 0;
    const blocksLo = sb.readUInt32LE(1024 + 0x4);
    const logBlock = sb.readUInt32LE(1024 + 0x18) & 0xffff;
    const blockSize = 1024 << logBlock;
    return blocksLo * blockSize;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  buildEmptyExt4, hasExt4Superblock, setEncryptFlag, clearEncryptFlag, fsBytes, BLOCK,
};
