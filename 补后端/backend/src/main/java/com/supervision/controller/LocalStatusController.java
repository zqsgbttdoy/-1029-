package com.supervision.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;

/** 只在回环监听的 local 环境提供启动就绪信号，不公开数据库路径、账号或凭据。 */
@RestController
@Profile("local")
public class LocalStatusController {
    @Value("${app.local.data-dir}")
    private String dataDir;
    private volatile boolean ready;

    @EventListener(ApplicationReadyEvent.class)
    public void started() throws IOException {
        Path marker = Path.of(dataDir).resolve("initialized.marker");
        if (!Files.exists(marker)) Files.writeString(marker, "persistent-local-v1\n", StandardOpenOption.CREATE_NEW);
        ready = true;
    }

    @EventListener(ContextClosedEvent.class)
    public void stopped() { ready = false; }

    @GetMapping("/local/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.status(ready ? 200 : 503).body(Map.of(
                "profile", "local", "persistent", true, "ready", ready, "pid", ProcessHandle.current().pid()));
    }
}
