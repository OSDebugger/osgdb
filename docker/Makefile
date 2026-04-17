TOOLCHAIN_NAME:=riscv64-unknown-elf-toolchain-10.2.0-2020.12.8-x86_64-linux-ubuntu14
GDB:=$(TOOLCHAIN_NAME)/bin/riscv64-unknown-elf-gdb
GDB_STARTUP_CMD:=gdb_startup_cmd.txt
PROJECT_NAME := rCore-Tutorial-v3
TARGET := riscv64gc-unknown-none-elf
MODE := release
SYMBOL_BIN := $(PROJECT_NAME)/os/target/$(TARGET)/$(MODE)/os
KERNEL_BIN := $(SYMBOL_BIN).bin
FS_IMG := $(PROJECT_NAME)/user/target/$(TARGET)/$(MODE)/fs.img

fast_github:
	@cd $(PROJECT_NAME) &&\
	git config --global url."https://hub.fastgit.xyz/".insteadOf "https://github.com/" &&\
	git config protocol.https.allow always


unzip_toolchain:
#   no need. docker extracted tar.gz archive when building image
#	@tar -xvf $(TOOLCHAIN_NAME).tar.gz


build:
	@cd $(PROJECT_NAME)/os && make build
run:
	@qemu-system-riscv64 \
		-machine virt \
		-nographic \
		-bios $(PROJECT_NAME)/bootloader/rustsbi-qemu.bin \
		-device loader,file=$(KERNEL_BIN),addr=0x80200000 \
		-drive file=$(FS_IMG),if=none,format=raw,id=x0 \
        -device virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0\
		-s -S 

## need modify GDB_STARTUP_CMD
run_gdbgui:
	@python3 -m gdbgui -r --gdb-cmd="$(GDB) -x $(GDB_STARTUP_CMD)" 

kill_qemu:
	@pkill qemu 
	@pkill qemu-system-riscv64 






