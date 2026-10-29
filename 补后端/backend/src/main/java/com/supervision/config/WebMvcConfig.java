package com.supervision.config;

import com.supervision.interceptor.AuthInterceptor;
import com.supervision.interceptor.RequestLoggingInterceptor;
import com.supervision.interceptor.RoleCheckInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;

import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@RequiredArgsConstructor
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final RequestLoggingInterceptor requestLoggingInterceptor;
    private final RoleCheckInterceptor roleCheckInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 请求日志先于鉴权执行，记录包括被拒绝的上传目录请求。
        registry.addInterceptor(requestLoggingInterceptor)
                .addPathPatterns("/**")
                .order(0);
        // 附件内容入口自行校验签名与业务权限；上传物理目录不公开映射。
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/**")
                .excludePathPatterns(
                        "/auth/login",
                        "/local/status",
                        "/files/content",
                        "/error"
                );
        // 角色校验拦截器：在 AuthInterceptor 之后执行，基于 @RequireRole 注解做接口级权限校验
        registry.addInterceptor(roleCheckInterceptor)
                .addPathPatterns("/**")
                .excludePathPatterns(
                        "/auth/login",
                        "/local/status",
                        "/files/content",
                        "/error"
                );
    }
}
